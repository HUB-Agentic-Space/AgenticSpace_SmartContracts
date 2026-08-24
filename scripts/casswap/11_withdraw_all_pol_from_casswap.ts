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
  "function withdrawPOL(uint256 amount) external",
  "function getPOLBalance() external view returns (uint256)",
  "function getCASBalance() external view returns (uint256)",
  "function infrastructureFund() external view returns (address)",
  "function isPaused() external view returns (bool)",
  "function TREASURER_ROLE() external view returns (bytes32)",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/casswap/11_withdraw_all_pol_from_casswap.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Saque de todo POL do CASSwap para InfrastructureFund");
  console.log(SEP);

  const env = requireEnv(["CAS_SWAP_ADDRESS"]);
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

  if (chainId !== 137 && chainId !== 80002) {
    log("WARN", "Nao esta na Polygon mainnet ou Amoy testnet", { chainId });
  }

  const casswapAddress = env.CAS_SWAP_ADDRESS;
  const casswap = new ethers.Contract(casswapAddress, CASSWAP_ABI, deployer);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);

  console.log(`\n${SUB}`);
  console.log("  Estado atual do CASSwap");
  console.log(SUB);

  const polBalance = await casswap.getPOLBalance();
  const casBalance = await casswap.getCASBalance();
  const infraFund = await casswap.infrastructureFund();
  const paused = await casswap.isPaused();

  log("INFO", "CASSwap state", {
    casswap: casswapAddress,
    polBalance: ethers.formatEther(polBalance),
    casBalance: ethers.formatEther(casBalance),
    infrastructureFund: infraFund,
    paused,
  });

  console.log(`  CASSwap:           ${casswapAddress}`);
  console.log(`  POL em estoque:    ${fmtPOL(polBalance)}`);
  console.log(`  CAS em estoque:    ${ethers.formatEther(casBalance)} CAS`);
  console.log(`  InfrastructureFund:${infraFund}`);
  console.log(`  Pausado:           ${paused}`);

  if (polBalance === 0n) {
    log("INFO", "Nao ha POL no CASSwap para sacar — nada a fazer");
    console.log(`\n${SEP}\n`);
    process.exit(0);
  }

  if (paused) {
    log("ERROR", "CASSwap esta pausado; nao e possivel sacar POL");
    process.exit(1);
  }

  if (infraFund === ethers.ZeroAddress) {
    log("ERROR", "InfrastructureFund nao configurado (zero address)");
    process.exit(1);
  }

  console.log(`\n${SUB}`);
  console.log("  Validacao de permissoes");
  console.log(SUB);

  const treasurerRole = await casswap.TREASURER_ROLE();
  const hasRole = await casswap.hasRole(treasurerRole, deployer.address);
  if (!hasRole) {
    log("ERROR", "Deployer nao possui TREASURER_ROLE", {
      deployer: deployer.address,
      role: treasurerRole,
    });
    process.exit(1);
  }

  log("INFO", "Permissao TREASURER_ROLE confirmada", { deployer: deployer.address });

  const infraPolBefore = await provider.getBalance(infraFund);
  log("INFO", "InfrastructureFund POL antes do saque", {
    address: infraFund,
    balance: ethers.formatEther(infraPolBefore),
  });

  console.log(`\n${SUB}`);
  console.log("  Validacao de gas");
  console.log(SUB);

  const deployerBalance = await provider.getBalance(deployer.address);
  let estimatedGas: bigint;
  try {
    estimatedGas = await casswap.withdrawPOL.estimateGas(polBalance, { gasPrice });
    log("INFO", "Simulacao OK (estimateGas)", { estimatedGas: estimatedGas.toString() });
  } catch (err: any) {
    log("ERROR", "Simulacao falhou", { reason: err.reason ?? err.message });
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

  log("INFO", "Saldo suficiente para gas", {
    balance: fmtPOL(deployerBalance),
    estimatedCost: fmtPOL(txCost),
  });

  console.log(`\n${SUB}`);
  console.log("  Resumo da transacao");
  console.log(SUB);
  console.log(`  CASSwap:           ${casswapAddress}`);
  console.log(`  POL a sacar:       ${fmtPOL(polBalance)}`);
  console.log(`  Destino (InfraFund): ${infraFund}`);
  console.log(`  Gas limit:         ${gasLimit.toString()}`);
  console.log(`  Gas price:         ${fmtGwei(gasPrice)}`);
  console.log(`  Custo gas est.:    ${fmtPOL(txCost)}`);

  console.log(`\n${SUB}`);
  console.log("  Envio da transacao: withdrawPOL");
  console.log(SUB);

  const txPromise = casswap.withdrawPOL(polBalance, { gasPrice, gasLimit });
  await sendAndVerify("withdrawPOL(all)", txPromise, gasPrice, gasLimit);

  const polBalanceAfter = await casswap.getPOLBalance();
  const infraPolAfter = await provider.getBalance(infraFund);

  log("INFO", "Saque concluido", {
    polRemaining: ethers.formatEther(polBalanceAfter),
    infraFundPolAfter: ethers.formatEther(infraPolAfter),
    polTransferred: ethers.formatEther(infraPolAfter - infraPolBefore),
  });

  console.log(`\n${SEP}`);
  console.log("  Saque concluido");
  console.log(SEP);
  console.log(`  CASSwap POL antes:    ${fmtPOL(polBalance)}`);
  console.log(`  CASSwap POL depois:   ${fmtPOL(polBalanceAfter)}`);
  console.log(`  InfraFund POL antes:  ${fmtPOL(infraPolBefore)}`);
  console.log(`  InfraFund POL depois: ${fmtPOL(infraPolAfter)}`);
  console.log(`  POL transferido:      ${fmtPOL(infraPolAfter - infraPolBefore)}`);
  console.log(`\n  Proximos passos:`);
  console.log(`    1. Verifique no explorer: https://polygonscan.com/address/${casswapAddress}`);
  console.log(`    2. Confirme saldo InfraFund: ${infraFund}`);
  console.log(`\n${SEP}\n`);
}

main().catch((err) => {
  log("ERROR", "Script failed", { error: err.message });
  console.error(err);
  process.exit(1);
});
