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

const DIAMOND_ABI = [
  "function supportSwap(uint8 reserveCurrency, uint256 amount, address to) external",
  "function getReserves() view returns (uint256 casBalance, uint256 usdcBalance, uint256 polBalance)",
  "function isSwapPaused() view returns (bool)",
  "function owner() view returns (address)",
];

const ACCESS_CONTROL_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

const RATIO_SETTER_ROLE = ethers.id("RATIO_SETTER_ROLE");
const CURRENCY_POL = 0;
const CURRENCY_USDC = 1;

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/casswap/23_support_swap_pol_withdraw.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Saque de POL do Diamond via supportSwap (CASSwapUSDCPOLFacet)");
  console.log(SEP);

  const env = requireEnv(["DIAMOND_ADDRESS"]);
  const [defaultSigner] = await ethers.getSigners();
  const provider = defaultSigner.provider!;

  // Usa RELAYER_PRIVATE_KEY (owner do Diamond) quando disponivel; caso
  // contrario, cai para o signer padrao (POLYGON_PRIVATE_KEY).
  const relayerKey = process.env.RELAYER_PRIVATE_KEY;
  const deployer = relayerKey
    ? new ethers.Wallet(relayerKey, provider)
    : defaultSigner;

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);

  console.log(`\n${SUB}`);
  console.log("  Rede");
  console.log(SUB);
  console.log(`  Rede:      ${netInfo.name}`);
  console.log(`  Chain ID:  ${chainId}`);
  console.log(`  Deployer:  ${deployer.address}`);
  if (relayerKey) {
    console.log(`  Signer:    RELAYER_PRIVATE_KEY (owner/relayer)`);
  }

  if (chainId !== 137) {
    log("ERROR", "Abortando: script deve rodar na Polygon mainnet (137)", { chainId });
    process.exit(1);
  }

  const diamondAddress = env.DIAMOND_ADDRESS;
  const diamond = new ethers.Contract(diamondAddress, DIAMOND_ABI, deployer);

  // Verificar owner
  const owner = await diamond.owner().catch(() => null);
  log("INFO", "Diamond owner", { owner });

  // Verificar permissao: owner ou RATIO_SETTER_ROLE
  const accessControl = new ethers.Contract(diamondAddress, ACCESS_CONTROL_ABI, provider);
  const hasRole = await accessControl.hasRole(RATIO_SETTER_ROLE, deployer.address).catch(() => false);
  const isOwner = owner && deployer.address.toLowerCase() === owner.toLowerCase();

  if (!isOwner && !hasRole) {
    log("ERROR", "Deployer nao possui RATIO_SETTER_ROLE nem e owner", {
      deployer: deployer.address,
      owner,
      hasRole,
    });
    process.exit(1);
  }

  log("INFO", "Permissao confirmada", {
    deployer: deployer.address,
    isOwner,
    hasRole,
  });

  // Estado atual
  const paused = await diamond.isSwapPaused().catch(() => null);
  const [casBalance, usdcBalance, polBalance] = await diamond.getReserves();

  log("INFO", "Estado atual do Diamond CASSwap", {
    casBalance: ethers.formatEther(casBalance),
    usdcBalance: ethers.formatUnits(usdcBalance, 6),
    polBalance: ethers.formatEther(polBalance),
    paused,
  });

  if (paused) {
    log("ERROR", "Swap esta pausado; nao e possivel executar supportSwap");
    process.exit(1);
  }

  if (polBalance === 0n) {
    log("INFO", "Nao ha POL no Diamond para sacar — nada a fazer");
    console.log(`\n${SEP}\n`);
    process.exit(0);
  }

  // Configurar destino e valor
  const toAddress = process.env.SUPPORT_SWAP_TO ?? "0xb72E7E3225eb846db1E4e346703a5ba2Cc89B837";
  const amountInput = (process.env.SUPPORT_SWAP_POL_AMOUNT ?? "max").trim().toLowerCase();

  let amountWei: bigint;
  if (amountInput === "max") {
    amountWei = polBalance;
  } else {
    amountWei = ethers.parseEther(amountInput);
    if (amountWei <= 0n) {
      log("ERROR", "SUPPORT_SWAP_POL_AMOUNT deve ser maior que zero ou 'max'");
      process.exit(1);
    }
    if (amountWei > polBalance) {
      log("ERROR", "Valor solicitado excede o saldo de POL no Diamond", {
        requested: ethers.formatEther(amountWei),
        available: ethers.formatEther(polBalance),
      });
      process.exit(1);
    }
  }

  // Gas
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);

  const deployerBalance = await provider.getBalance(deployer.address);
  const estimatedGas = await diamond.supportSwap.estimateGas(CURRENCY_POL, amountWei, toAddress, { gasPrice }).catch(() => null);

  if (!estimatedGas) {
    log("ERROR", "Simulacao de gas falhou");
    process.exit(1);
  }

  const gasLimit = (estimatedGas * 120n) / 100n;
  const txCost = gasLimit * gasPrice;

  if (deployerBalance < txCost) {
    log("ERROR", "Saldo insuficiente para cobrir o gas", {
      balance: fmtPOL(deployerBalance),
      cost: fmtPOL(txCost),
    });
    process.exit(1);
  }

  console.log(`\n${SUB}`);
  console.log("  Resumo da transacao");
  console.log(SUB);
  console.log(`  Diamond:           ${diamondAddress}`);
  console.log(`  Funcao:            supportSwap(POL, amount, to)`);
  console.log(`  Reserve currency:  POL (0)`);
  console.log(`  Destino (to):      ${toAddress}`);
  console.log(`  POL a sacar:       ${fmtPOL(amountWei)}`);
  console.log(`  Gas limit:         ${gasLimit.toString()}`);
  console.log(`  Gas price:         ${fmtGwei(gasPrice)}`);
  console.log(`  Custo gas est.:    ${fmtPOL(txCost)}`);
  console.log(`  Saldo deployer:    ${fmtPOL(deployerBalance)}`);

  const destBalanceBefore = await provider.getBalance(toAddress);
  log("INFO", "Saldo do destino antes do saque", {
    to: toAddress,
    balance: ethers.formatEther(destBalanceBefore),
  });

  const dryRun = process.env.DRY_RUN === "true";

  console.log(`\n${SUB}`);
  console.log(`  ${dryRun ? "DRY RUN — simulacao sem envio" : "Envio da transacao: supportSwap"}`);
  console.log(SUB);

  if (dryRun) {
    log("WARN", "DRY_RUN ativo — transacao NAO sera enviada");
    console.log(`  TX simulada: supportSwap(${CURRENCY_POL}, ${amountWei}, ${toAddress})`);
    console.log(`  Estimativa gas: ${estimatedGas}`);
    console.log(`\n${SEP}\n`);
    process.exit(0);
  }

  const txPromise = diamond.supportSwap(CURRENCY_POL, amountWei, toAddress, { gasPrice, gasLimit });
  await sendAndVerify("supportSwap(POL, amount, to)", txPromise, gasPrice, gasLimit);

  const [casAfter, usdcAfter, polAfter] = await diamond.getReserves();
  const destBalanceAfter = await provider.getBalance(toAddress);

  log("INFO", "Saque concluido", {
    polRemaining: ethers.formatEther(polAfter),
    destBalanceAfter: ethers.formatEther(destBalanceAfter),
    polTransferred: ethers.formatEther(destBalanceAfter - destBalanceBefore),
  });

  console.log(`\n${SEP}`);
  console.log("  Saque concluido");
  console.log(SEP);
  console.log(`  Diamond POL antes:    ${fmtPOL(polBalance)}`);
  console.log(`  Diamond POL depois:   ${fmtPOL(polAfter)}`);
  console.log(`  Destino antes:        ${fmtPOL(destBalanceBefore)}`);
  console.log(`  Destino depois:       ${fmtPOL(destBalanceAfter)}`);
  console.log(`  POL transferido:      ${fmtPOL(destBalanceAfter - destBalanceBefore)}`);
  console.log(`\n  Proximos passos:`);
  console.log(`    1. Verifique no explorer: https://polygonscan.com/address/${diamondAddress}`);
  console.log(`    2. Confirme saldo destino: ${toAddress}`);
  console.log(`\n${SEP}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "Script failed", { error: err.message });
    console.error(err);
    process.exit(1);
  });
