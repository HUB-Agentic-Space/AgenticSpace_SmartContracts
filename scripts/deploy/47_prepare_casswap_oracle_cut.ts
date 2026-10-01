import { ethers, network } from "hardhat";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { IDiamondCut } from "../../typechain-types";

const DIAMOND = "0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b";
const TIMELOCK = "0x6e14dA17C2B9df7A5d829897F9c39b61D9E8d4B5";
const DELAY = 172800n;

// Fontes de oráculo — Polygon mainnet (chainId 137)
const POL_USD_FEED = process.env.CHAINLINK_POL_USD_FEED ?? "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0";
const USDC_USD_FEED = process.env.CHAINLINK_USDC_USD_FEED ?? "0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7";
const BRL_USD_FEED = process.env.CHAINLINK_BRL_USD_FEED ?? "0xB90DA3ff54C3ED09115abf6FbA0Ff4645586af2c";
const UNIV3_CAS_POOL = process.env.UNIV3_CAS_WPOL_POOL ?? "0x2a37bcA556c39418B779901f9b2988414Ee550Dc";
const SUSHI_CAS_PAIR = process.env.SUSHISWAP_CAS_WPOL_PAIR ?? "0x265D86d4D43c32037b032097e8bFB6893E1C3964";

const TWAP_WINDOW = 1800;        // 30 min — janela TWAP CAS/WPOL
const CL_STALE_CRYPTO = 7200;    // 2h — heartbeat/deviation feeds crypto
const CL_STALE_FX = 172800;      // 48h — BRL/USD é FX (fecha fds)
const LEGACY_RATIO_MAX_AGE = 345600; // 96h — cobre timelock 48h + warm-up do TWAP
                                     // com o publisher já desligado; depois do
                                     // oráculo ativo limita ratio muito velho

/**
 * Prepara o corte "oracle pricing" do CASSwap:
 *  - replace dos seletores do CASSwapUSDCPOLFacet (LibCASSwap passa a
 *    delegar buyRatioFor/sellRatioFor ao oráculo quando habilitado);
 *  - add do CASSwapOracleFacet (setOracleConfig/setOracleEnabled/
 *    updateCasTwap/getCasPriceSources/getOracleRatio/oraclePricingEnabled);
 *  - initCalldata = setOracleConfig(...) com `enabled=true` — a âncora do
 *    TWAP SushiSwap é registrada na execução do corte e o fallback aos
 *    ratios armazenados cobre o aquecimento (~30min) e falhas de oráculo
 *    por até legacyRatioMaxAge.
 *
 * PRÉ-REQUISITO operacional (antes de executar o corte): o pool UniV3
 * CAS/WPOL precisa ter liquidez e cardinalidade de observação suficiente
 * (increaseObservationCardinalityNext) — sem isso a fonte UniV3 é ignorada
 * e o envelope usa apenas o TWAP SushiSwap.
 *
 * Uso: npx hardhat run scripts/deploy/47_prepare_casswap_oracle_cut.ts --network polygon
 */
function selectorsOf(contract: any): string[] {
  const selectors: string[] = [];
  contract.interface.forEachFunction((fragment: any) => selectors.push(fragment.selector));
  return [...new Set(selectors)];
}

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [47_prepare_casswap_oracle_cut:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");
  const [deployer] = await ethers.getSigners();

  const swapFactory = await ethers.getContractFactory("CASSwapUSDCPOLFacet", deployer);
  const swapFacet = await swapFactory.deploy();
  await swapFacet.waitForDeployment();
  const swapFacetAddress = await swapFacet.getAddress();

  const oracleFactory = await ethers.getContractFactory("CASSwapOracleFacet", deployer);
  const oracleFacet = await oracleFactory.deploy();
  await oracleFacet.waitForDeployment();
  const oracleFacetAddress = await oracleFacet.getAddress();

  const deployTxs = [
    swapFacet.deploymentTransaction()?.hash,
    oracleFacet.deploymentTransaction()?.hash,
  ];
  log("info", "facets_deployed", `swap=${swapFacetAddress} oracle=${oracleFacetAddress} txs=${deployTxs.join(",")}`);

  const loupe = await ethers.getContractAt("DiamondLoupeFacet", DIAMOND, deployer);
  const cuts: IDiamondCut.FacetCutStruct[] = [];
  const selectorReport: Array<{ facet: string; action: number; selector: string; signature: string }> = [];

  for (const [name, facetAddress, contract] of [
    ["swap", swapFacetAddress, swapFacet],
    ["oracle", oracleFacetAddress, oracleFacet],
  ] as const) {
    const replace: string[] = [];
    const add: string[] = [];
    for (const selector of selectorsOf(contract)) {
      const current = await loupe.facetAddress(selector);
      (current === ethers.ZeroAddress ? add : replace).push(selector);
    }
    if (replace.length > 0) cuts.push({ facetAddress, action: 1, functionSelectors: replace });
    if (add.length > 0) cuts.push({ facetAddress, action: 0, functionSelectors: add });
    for (const [selector, action] of [...replace.map((s) => [s, 1] as const), ...add.map((s) => [s, 0] as const)]) {
      const fragment = contract.interface.getFunction(selector);
      selectorReport.push({ facet: name, action, selector, signature: fragment?.format("sighash") ?? "" });
    }
  }

  // Init: configura oráculo já habilitado — âncora TWAP na execução do corte.
  const initAddress = oracleFacetAddress;
  const initCalldata = oracleFacet.interface.encodeFunctionData("setOracleConfig", [
    POL_USD_FEED, USDC_USD_FEED, BRL_USD_FEED, UNIV3_CAS_POOL, SUSHI_CAS_PAIR,
    TWAP_WINDOW, CL_STALE_CRYPTO, CL_STALE_FX, LEGACY_RATIO_MAX_AGE, true,
  ]);
  log("info", "init_encoded", `init=${initAddress} calldata=${initCalldata.slice(0, 74)}...`);

  const cutInterface = new ethers.Interface([
    "function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[] cut,address init,bytes calldata data)",
  ]);
  const cutCalldata = cutInterface.encodeFunctionData("diamondCut", [cuts, initAddress, initCalldata]);
  const predecessor = ethers.ZeroHash;
  const salt = ethers.keccak256(ethers.toUtf8Bytes(`CASSwapOracle:${swapFacetAddress}:${oracleFacetAddress}:v4-oracle`));
  const timelockInterface = new ethers.Interface([
    "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
    "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) view returns(bytes32)",
  ]);
  const scheduleCalldata = timelockInterface.encodeFunctionData("schedule", [DIAMOND, 0, cutCalldata, predecessor, salt, DELAY]);
  const timelock = new ethers.Contract(TIMELOCK, timelockInterface, ethers.provider);
  const operationId = await timelock.hashOperation(DIAMOND, 0, cutCalldata, predecessor, salt);

  const output = {
    network: network.name,
    chainId: 137,
    diamond: DIAMOND,
    timelock: TIMELOCK,
    swapFacet: swapFacetAddress,
    oracleFacet: oracleFacetAddress,
    oracleConfig: {
      polUsdFeed: POL_USD_FEED,
      usdcUsdFeed: USDC_USD_FEED,
      brlUsdFeed: BRL_USD_FEED,
      uniV3CasPool: UNIV3_CAS_POOL,
      sushiCasPair: SUSHI_CAS_PAIR,
      twapWindow: TWAP_WINDOW,
      clStaleCrypto: CL_STALE_CRYPTO,
      clStaleFx: CL_STALE_FX,
      legacyRatioMaxAge: LEGACY_RATIO_MAX_AGE,
      enabled: true,
    },
    initAddress,
    initCalldata,
    cuts,
    selectors: selectorReport,
    cutCalldata,
    predecessor,
    salt,
    delaySeconds: DELAY.toString(),
    operationId,
    safeScheduleTransaction: { to: TIMELOCK, value: "0", data: scheduleCalldata },
  };
  const outputPath = resolve(__dirname, "../../deployments/casswap-oracle-cut.json");
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  log("info", "cut_prepared", `cuts=${cuts.length} operationId=${operationId} output=${outputPath}`);
}

main().catch((error) => {
  log("error", "preparation_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
