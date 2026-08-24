import "dotenv/config";
import { ethers } from "hardhat";
import {
  SEP,
  SUB,
  fmtPOL,
  fmtGwei,
  getNetworkInfo,
  requireEnv,
  sendAndVerify,
} from "../utils/deploy_helpers";

const CHAINLINK_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];

const BUYBACK_BURN_ABI = [
  "function executeBuyback(uint256 minCasOut, uint256 deadline) returns (uint256 casBought, uint256 casBurned)",
  "function getPOLBalance() view returns (uint256)",
  "function getSlippageBps() view returns (uint256)",
  "function getMinBuybackAmount() view returns (uint256)",
  "function isPaused() view returns (bool)",
  "function getCasToken() view returns (address)",
  "function getDexRouter() view returns (address)",
  "function OPERATOR_ROLE() view returns (bytes32)",
  "function hasRole(bytes32, address) view returns (bool)",
  "event BuybackExecuted(address indexed caller, uint256 polSpent, uint256 casBought, uint256 casBurned)",
];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/casswap/18_execute_buyback.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Executar Buyback e Burn de CAS");
  console.log(SEP);

  const env = requireEnv(["BUYBACK_BURN_ADDRESS", "CAS_TOKEN_ADDRESS", "CHAINLINK_POL_USD_FEED"]);
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);

  console.log(`\n${SUB}`);
  console.log("  Rede");
  console.log(SUB);
  console.log(`  Rede:      ${netInfo.name}`);
  console.log(`  Chain ID:  ${chainId}`);
  console.log(`  Deployer:  ${deployer.address}`);

  if (chainId !== 137) {
    log("ERROR", "Abortando: script deve rodar na Polygon mainnet (137)", { chainId });
    process.exit(1);
  }

  const buybackAddress = env.BUYBACK_BURN_ADDRESS;
  const casTokenAddress = env.CAS_TOKEN_ADDRESS;
  const casPriceUsd = parseFloat(process.env.CAS_PRICE_USD ?? "0.0005");

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);

  const buyback = new ethers.Contract(buybackAddress, BUYBACK_BURN_ABI, deployer);

  // Check state
  const polBalance = await buyback.getPOLBalance();
  const slippageBps = await buyback.getSlippageBps();
  const minBuybackAmount = await buyback.getMinBuybackAmount();
  const isPaused = await buyback.isPaused();
  const casToken = await buyback.getCasToken();
  const dexRouter = await buyback.getDexRouter();

  const operatorRole = await buyback.OPERATOR_ROLE();
  const hasOperatorRole = await buyback.hasRole(operatorRole, deployer.address);

  log("INFO", "Estado do BuybackBurn", {
    polBalance: ethers.formatEther(polBalance),
    slippageBps: slippageBps.toString(),
    minBuybackAmount: ethers.formatEther(minBuybackAmount),
    isPaused,
    casToken,
    dexRouter,
    hasOperatorRole,
  });

  if (isPaused) {
    log("ERROR", "BuybackBurn esta pausado. Despause antes de executar.");
    process.exit(1);
  }

  if (!hasOperatorRole) {
    log("ERROR", "Deployer nao tem OPERATOR_ROLE no BuybackBurn", { deployer: deployer.address });
    process.exit(1);
  }

  if (polBalance < minBuybackAmount) {
    log("ERROR", "Saldo de POL no BuybackBurn abaixo do minimo", {
      polBalance: ethers.formatEther(polBalance),
      minBuybackAmount: ethers.formatEther(minBuybackAmount),
    });
    process.exit(1);
  }

  // Fetch POL/USD from Chainlink to calculate minCasOut
  const chainlink = new ethers.Contract(env.CHAINLINK_POL_USD_FEED.toLowerCase(), CHAINLINK_ABI, provider);
  const [, polPriceRaw] = await chainlink.latestRoundData();
  const chainlinkDecimals = await chainlink.decimals();
  const polPriceUsd = Number(polPriceRaw) / Number(10n ** BigInt(chainlinkDecimals));

  const casPerPol = polPriceUsd / casPriceUsd;
  const expectedCasOut = Number(ethers.formatEther(polBalance)) * casPerPol;
  const slippageFactor = (10000 - Number(slippageBps)) / 10000;
  const minCasOut = ethers.parseEther((expectedCasOut * slippageFactor).toFixed(18));

  log("INFO", "Calculo de buyback", {
    polPriceUsd: polPriceUsd.toFixed(6),
    casPriceUsd: casPriceUsd.toFixed(6),
    casPerPol: casPerPol.toFixed(2),
    polToSpend: ethers.formatEther(polBalance),
    expectedCasOut: expectedCasOut.toFixed(2),
    slippageBps: slippageBps.toString(),
    minCasOut: ethers.formatEther(minCasOut),
  });

  const deadline = Math.floor(Date.now() / 1000) + 600;

  console.log(`\n${SUB}`);
  console.log("  Resumo da transacao");
  console.log(SUB);
  console.log(`  Contrato:     ${buybackAddress}`);
  console.log(`  POL a gastar: ${fmtPOL(polBalance)}`);
  console.log(`  Min CAS out:  ${ethers.formatEther(minCasOut)} CAS`);
  console.log(`  Slippage:     ${slippageBps.toString()} bps (${Number(slippageBps) / 100}%)`);
  console.log(`  Deadline:     ${new Date(deadline * 1000).toISOString()}`);

  const gasLimit = 300_000n;

  const tx = buyback.executeBuyback(minCasOut, BigInt(deadline));

  await sendAndVerify(
    "executeBuyback — compra CAS e queima",
    tx,
    gasPrice,
    gasLimit,
  );

  // Check final state
  const finalPolBalance = await buyback.getPOLBalance();

  const casTokenContract = new ethers.Contract(
    casTokenAddress,
    ["function totalSupply() view returns (uint256)"],
    provider,
  );
  const finalCasSupply = await casTokenContract.totalSupply();

  log("INFO", "Buyback concluido", {
    finalPolBalance: ethers.formatEther(finalPolBalance),
    finalCasSupply: ethers.formatEther(finalCasSupply),
    polSpent: ethers.formatEther(polBalance - finalPolBalance),
  });

  console.log(`\n${SUB}`);
  console.log("  Resultado");
  console.log(SUB);
  console.log(`  POL gasto:       ${fmtPOL(polBalance - finalPolBalance)}`);
  console.log(`  POL restante:    ${fmtPOL(finalPolBalance)}`);
  console.log(`  CAS total supply:${ethers.formatEther(finalCasSupply)}`);
  console.log(`\n  Proximos passos:`);
  console.log(`    1. Monitorar preco do CAS nas DEXs`);
  console.log(`    2. Depositar mais POL no BuybackBurn se necessario`);
  console.log(`    3. Executar novo buyback quando acumular POL suficiente`);
  console.log(`\n${SEP}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "Script failed", { error: err.message });
    console.error(err);
    process.exit(1);
  });
