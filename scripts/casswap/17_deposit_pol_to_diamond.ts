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
  "function getReserves() view returns (uint256 casBalance, uint256 usdcBalance, uint256 polBalance)",
  "function isSwapPaused() view returns (bool)",
];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/casswap/17_deposit_pol_to_diamond.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Deposito de POL no Diamond (CASSwapUSDCPOLFacet)");
  console.log(SEP);

  const env = requireEnv(["DIAMOND_ADDRESS", "POL_DEPOSIT_AMOUNT"]);
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

  const diamondAddress = env.DIAMOND_ADDRESS;
  const depositInput = env.POL_DEPOSIT_AMOUNT.trim().toLowerCase();
  const gasReserveInput = process.env.GAS_RESERVE_POL ?? "0.2";
  const gasReserveWei = ethers.parseEther(gasReserveInput);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);

  const diamond = new ethers.Contract(diamondAddress, DIAMOND_ABI, provider);

  const initialBalance = await provider.getBalance(deployer.address);
  const initialDiamondPOL = await provider.getBalance(diamondAddress);

  let initialReserves: { casBalance: bigint; usdcBalance: bigint; polBalance: bigint };
  try {
    const [casBal, usdcBal, polBal] = await diamond.getReserves();
    initialReserves = { casBalance: casBal, usdcBalance: usdcBal, polBalance: polBal };
  } catch {
    initialReserves = { casBalance: 0n, usdcBalance: 0n, polBalance: initialDiamondPOL };
  }

  const isPaused = await diamond.isSwapPaused().catch(() => null);

  log("INFO", "Estado inicial", {
    deployerPOL: ethers.formatEther(initialBalance),
    diamondPOL: ethers.formatEther(initialDiamondPOL),
    diamondReserves: {
      cas: ethers.formatEther(initialReserves.casBalance),
      usdc: ethers.formatUnits(initialReserves.usdcBalance, 6),
      pol: ethers.formatEther(initialReserves.polBalance),
    },
    swapPaused: isPaused,
    gasReserve: ethers.formatEther(gasReserveWei),
  });

  console.log(`\n${SUB}`);
  console.log("  Validacao");
  console.log(SUB);

  let depositWei: bigint;
  let isMax = false;

  const gasEstimate = await deployer.estimateGas({
    to: diamondAddress,
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
    diamondAddress,
    deposit: ethers.formatEther(depositWei),
    isMax,
    gasLimit: gasLimit.toString(),
    gasPrice: fmtGwei(gasPrice),
    gasCost: ethers.formatEther(gasCost),
  });

  console.log(`\n${SUB}`);
  console.log("  Resumo da transacao");
  console.log(SUB);
  console.log(`  Destino:        ${diamondAddress} (Diamond)`);
  console.log(`  Valor:          ${fmtPOL(depositWei)}`);
  console.log(`  Gas limit:      ${gasLimit.toString()}`);
  console.log(`  Gas price:      ${fmtGwei(gasPrice)}`);
  console.log(`  Custo gas est.: ${fmtPOL(gasCost)}`);
  console.log(`  Saldo deployer: ${fmtPOL(initialBalance)}`);
  console.log(`  Reserva gas:    ${fmtPOL(gasReserveWei)}`);

  await sendAndVerify(
    "Deposito de POL no Diamond",
    deployer.sendTransaction({
      to: diamondAddress,
      value: depositWei,
      gasPrice,
      gasLimit,
    }),
    gasPrice,
    gasLimit,
  );

  const finalBalance = await provider.getBalance(deployer.address);
  const finalDiamondPOL = await provider.getBalance(diamondAddress);

  let finalReserves: { casBalance: bigint; usdcBalance: bigint; polBalance: bigint };
  try {
    const [casBal, usdcBal, polBal] = await diamond.getReserves();
    finalReserves = { casBalance: casBal, usdcBalance: usdcBal, polBalance: polBal };
  } catch {
    finalReserves = { casBalance: 0n, usdcBalance: 0n, polBalance: finalDiamondPOL };
  }

  log("INFO", "Estado final", {
    deployerPOL: ethers.formatEther(finalBalance),
    diamondPOL: ethers.formatEther(finalDiamondPOL),
    diamondReserves: {
      cas: ethers.formatEther(finalReserves.casBalance),
      usdc: ethers.formatUnits(finalReserves.usdcBalance, 6),
      pol: ethers.formatEther(finalReserves.polBalance),
    },
    spent: ethers.formatEther(initialBalance - finalBalance),
    depositSent: ethers.formatEther(depositWei),
  });

  console.log(`\n${SUB}`);
  console.log("  Resultado");
  console.log(SUB);
  console.log(`  Diamond POL antes:  ${fmtPOL(initialDiamondPOL)}`);
  console.log(`  Diamond POL depois: ${fmtPOL(finalDiamondPOL)}`);
  console.log(`  Deployer POL antes: ${fmtPOL(initialBalance)}`);
  console.log(`  Deployer POL depois:${fmtPOL(finalBalance)}`);
  console.log(`  Total gasto:        ${fmtPOL(initialBalance - finalBalance)}`);
  console.log(`\n  Proximos passos:`);
  console.log(`    1. Configurar ratio: npx hardhat run scripts/casswap/19_set_diamond_ratio_target.ts --network polygon`);
  console.log(`    2. Verificar swap:   npx hardhat run scripts/casswap/01_check_casswap_state.ts --network polygon`);
  console.log(`\n${SEP}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "Script failed", { error: err.message });
    console.error(err);
    process.exit(1);
  });
