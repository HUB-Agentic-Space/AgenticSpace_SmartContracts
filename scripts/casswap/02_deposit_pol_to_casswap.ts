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

const CASSWAP_ABI = [
  "function getPOLBalance() view returns (uint256)",
  "function getCASBalance() view returns (uint256)",
];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/casswap/02_deposit_pol_to_casswap.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Deposito de POL no CASSwap");
  console.log(SEP);

  const env = requireEnv(["CAS_SWAP_ADDRESS", "POL_DEPOSIT_AMOUNT"]);
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

  const casswapAddress = env.CAS_SWAP_ADDRESS;
  const depositInput = env.POL_DEPOSIT_AMOUNT.trim().toLowerCase();
  const gasReserveInput = process.env.GAS_RESERVE_POL ?? "0.2";
  const gasReserveWei = ethers.parseEther(gasReserveInput);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);

  const initialBalance = await provider.getBalance(deployer.address);
  const initialCasswapPOL = await provider.getBalance(casswapAddress);

  log("INFO", "Estado inicial", {
    deployerPOL: ethers.formatEther(initialBalance),
    casswapPOL: ethers.formatEther(initialCasswapPOL),
    gasReserve: ethers.formatEther(gasReserveWei),
  });

  console.log(`\n${SUB}`);
  console.log("  Validacao");
  console.log(SUB);

  let depositWei: bigint;
  let isMax = false;

  // Estimate gas using a dummy 1 wei transfer to the same contract.
  const gasEstimate = await deployer.estimateGas({
    to: casswapAddress,
    value: 1n,
    gasPrice,
  }).catch(() => 60_000n);

  const gasLimit = (gasEstimate * 120n) / 100n;
  const gasCost = gasLimit * gasPrice;

  if (depositInput === "max") {
    isMax = true;
    const maxDeposit = initialBalance - gasCost - gasReserveWei;
    if (maxDeposit <= 0n) {
      log("ERROR", "Saldo insuficiente para deposito maximo", {
        balance: ethers.formatEther(initialBalance),
        gasCost: ethers.formatEther(gasCost),
        reserve: ethers.formatEther(gasReserveWei),
      });
      process.exit(1);
    }
    depositWei = maxDeposit;
  } else {
    depositWei = ethers.parseEther(depositInput);
    if (depositWei <= 0n) {
      log("ERROR", "POL_DEPOSIT_AMOUNT deve ser maior que zero");
      process.exit(1);
    }
    const required = depositWei + gasCost + gasReserveWei;
    if (initialBalance < required) {
      log("ERROR", "Saldo insuficiente para deposito + gas + reserva", {
        balance: ethers.formatEther(initialBalance),
        deposit: ethers.formatEther(depositWei),
        gasCost: ethers.formatEther(gasCost),
        reserve: ethers.formatEther(gasReserveWei),
        required: ethers.formatEther(required),
      });
      process.exit(1);
    }
  }

  log("INFO", "Transacao aprovada para broadcast", {
    casswapAddress,
    deposit: ethers.formatEther(depositWei),
    isMax,
    gasLimit: gasLimit.toString(),
    gasPrice: fmtGwei(gasPrice),
    gasCost: ethers.formatEther(gasCost),
  });

  console.log(`\n${SUB}`);
  console.log("  Resumo da transacao");
  console.log(SUB);
  console.log(`  Destino:        ${casswapAddress}`);
  console.log(`  Valor:          ${fmtPOL(depositWei)}`);
  console.log(`  Gas limit:      ${gasLimit.toString()}`);
  console.log(`  Gas price:      ${fmtGwei(gasPrice)}`);
  console.log(`  Custo gas est.: ${fmtPOL(gasCost)}`);
  console.log(`  Saldo deployer: ${fmtPOL(initialBalance)}`);
  console.log(`  Reserva gas:    ${fmtPOL(gasReserveWei)}`);

  await sendAndVerify(
    "Deposito de POL no CASSwap",
    deployer.sendTransaction({
      to: casswapAddress,
      value: depositWei,
      gasPrice,
      gasLimit,
    }),
    gasPrice,
    gasLimit,
  );

  const finalBalance = await provider.getBalance(deployer.address);
  const finalCasswapPOL = await provider.getBalance(casswapAddress);

  log("INFO", "Estado final", {
    deployerPOL: ethers.formatEther(finalBalance),
    casswapPOL: ethers.formatEther(finalCasswapPOL),
    spent: ethers.formatEther(initialBalance - finalBalance),
    depositSent: ethers.formatEther(depositWei),
  });

  console.log(`\n${SUB}`);
  console.log("  Resultado");
  console.log(SUB);
  console.log(`  CASSwap POL antes: ${fmtPOL(initialCasswapPOL)}`);
  console.log(`  CASSwap POL depois:${fmtPOL(finalCasswapPOL)}`);
  console.log(`  Deployer POL antes:${fmtPOL(initialBalance)}`);
  console.log(`  Deployer POL depois:${fmtPOL(finalBalance)}`);
  console.log(`  Total gasto:       ${fmtPOL(initialBalance - finalBalance)}`);
  console.log(`\n${SEP}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "Script failed", { error: err.message });
    console.error(err);
    process.exit(1);
  });
