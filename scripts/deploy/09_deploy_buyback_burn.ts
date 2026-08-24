import "dotenv/config";
import { ethers, upgrades } from "hardhat";
import {
  SEP,
  SUB,
  fmtPOL,
  fmtGwei,
  getNetworkInfo,
  requireEnv,
  sendAndVerify,
  printSummary,
} from "../utils/deploy_helpers";

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/deploy/09_deploy_buyback_burn.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Deploy BuybackBurn (UUPS Upgradeable)");
  console.log(SEP);

  const env = requireEnv(["CAS_TOKEN_ADDRESS"]);
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

  const casTokenAddress = env.CAS_TOKEN_ADDRESS;
  const sushiRouterAddress = process.env.SUSHISWAP_ROUTER_ADDRESS ?? "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";
  const quickswapRouterAddress = process.env.QUICKSWAP_ROUTER_ADDRESS ?? "0xa5E0829CaCEd8fFCEEd813c0150ceac53f3FD19f";
  const dexRouterAddress = process.env.BUYBACK_DEX_ROUTER ?? sushiRouterAddress;
  const wpolAddress = process.env.WPOL_ADDRESS ?? "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;
  const initialBalance = await provider.getBalance(deployer.address);

  console.log(`  Gas price:  ${fmtGwei(gasPrice)}`);
  console.log(`  Saldo:      ${fmtPOL(initialBalance)}`);

  log("INFO", "Parametros de deploy", {
    casToken: casTokenAddress,
    dexRouter: dexRouterAddress,
    wpol: wpolAddress,
    admin: deployer.address,
  });

  console.log(`\n${SUB}`);
  console.log("  Deploy BuybackBurn via UUPS Proxy");
  console.log(SUB);

  const BuybackBurn = await ethers.getContractFactory("BuybackBurn");
  const proxy = await upgrades.deployProxy(
    BuybackBurn,
    [deployer.address, casTokenAddress, dexRouterAddress, wpolAddress],
    { kind: "uups" },
  );

  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();

  log("INFO", "BuybackBurn deployado", {
    proxyAddress,
    admin: deployer.address,
    casToken: casTokenAddress,
    dexRouter: dexRouterAddress,
    wpol: wpolAddress,
  });

  // Verify initial state
  const casToken = await proxy.getCasToken();
  const dexRouter = await proxy.getDexRouter();
  const wpol = await proxy.getWpol();
  const slippageBps = await proxy.getSlippageBps();
  const minBuybackAmount = await proxy.getMinBuybackAmount();
  const isPaused = await proxy.isPaused();

  log("INFO", "Estado inicial verificado", {
    casToken,
    dexRouter,
    wpol,
    slippageBps: slippageBps.toString(),
    minBuybackAmount: ethers.formatEther(minBuybackAmount),
    isPaused,
  });

  const finalBalance = await provider.getBalance(deployer.address);

  await printSummary(
    "Deploy BuybackBurn Concluido",
    [
      { label: "Proxy (UUPS):", value: proxyAddress },
      { label: "Admin:", value: deployer.address },
      { label: "CAS Token:", value: casTokenAddress },
      { label: "DEX Router:", value: dexRouterAddress },
      { label: "WPOL:", value: wpolAddress },
      { label: "Slippage:", value: `${slippageBps.toString()} bps` },
      { label: "Min buyback:", value: `${ethers.formatEther(minBuybackAmount)} POL` },
    ],
    initialBalance,
    [
      `Adicione BUYBACK_BURN_ADDRESS=${proxyAddress} ao .env`,
      `Depositar POL: npx hardhat run scripts/casswap/18_execute_buyback.ts --network polygon (apos depositar POL no contrato)`,
      `Verificar no Polygonscan: https://polygonscan.com/address/${proxyAddress}`,
    ],
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "Script failed", { error: err.message });
    console.error(err);
    process.exit(1);
  });
