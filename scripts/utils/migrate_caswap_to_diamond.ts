import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as path from "path";

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

if (network.config.chainId !== 137) {
  throw new Error("This script only runs on Polygon mainnet (chainId 137)");
}

const CAS_SWAP_ADDRESS = process.env.CAS_SWAP_ADDRESS!;
const INFRASTRUCTURE_FUND_ADDRESS = process.env.INFRASTRUCTURE_FUND_ADDRESS!;
const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS!;
const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS!;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const CASSWAP_ABI = [
  "function paused() view returns (bool)",
  "function pause()",
  "function unpause()",
  "function withdrawCAS(address to, uint256 amount)",
  "function withdrawPOL(uint256 amount)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getCASBalance() view returns (uint256)",
  "function getPOLBalance() view returns (uint256)",
];

const INFRA_FUND_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function transferCasToRapport(uint256 amount)",
  "function transferNativeToRapport(uint256 amount)",
  "function paused() view returns (bool)",
];

const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TREASURER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TREASURER_ROLE"));
const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] [migrate_caswap_to_diamond] ${level} ${message}${params ? ` - ${JSON.stringify(params)}` : ""}`);
}

function fmtCAS(v: bigint): string {
  return ethers.formatEther(v);
}

function fmtPOL(v: bigint): string {
  return ethers.formatEther(v);
}

async function main(): Promise<void> {
  const [signer] = await ethers.getSigners();
  log("INFO", "signer", { address: signer.address });

  const casToken = new ethers.Contract(CAS_TOKEN_ADDRESS, ERC20_ABI, signer);
  const casSwap = new ethers.Contract(CAS_SWAP_ADDRESS, CASSWAP_ABI, signer);
  const infraFund = new ethers.Contract(INFRASTRUCTURE_FUND_ADDRESS, INFRA_FUND_ABI, signer);

  const decimals = await casToken.decimals();
  const symbol = await casToken.symbol();
  log("INFO", "token", { symbol, decimals: Number(decimals) });

  // ------------------------------------------------------------------
  // Pre-checks
  // ------------------------------------------------------------------
  const isAdmin = await casSwap.hasRole(DEFAULT_ADMIN_ROLE, signer.address);
  const isTreasurer = await infraFund.hasRole(TREASURER_ROLE, signer.address);
  const isPauser = await casSwap.hasRole(PAUSER_ROLE, signer.address);

  if (!isAdmin) throw new Error(`Signer ${signer.address} does not have DEFAULT_ADMIN_ROLE on CASSwap`);
  if (!isTreasurer) throw new Error(`Signer ${signer.address} does not have TREASURER_ROLE on InfrastructureFund`);

  log("INFO", "roles_ok", { isAdmin, isTreasurer, isPauser });

  const swapCasBalance = await casToken.balanceOf(CAS_SWAP_ADDRESS);
  const swapPolBalance = await ethers.provider.getBalance(CAS_SWAP_ADDRESS);

  log("INFO", "casswap_balances", { cas: fmtCAS(swapCasBalance), pol: fmtPOL(swapPolBalance) });

  if (swapCasBalance === 0n && swapPolBalance === 0n) {
    log("INFO", "nothing_to_migrate");
    return;
  }

  const wasPaused = await casSwap.paused();
  log("INFO", "casswap_paused", { wasPaused });

  // ------------------------------------------------------------------
  // Step 1: withdraw CAS/POL from old CASSwap to InfrastructureFund
  // ------------------------------------------------------------------
  if (swapCasBalance > 0n) {
    if (wasPaused) {
      if (!isPauser) throw new Error("CASSwap is paused and signer lacks PAUSER_ROLE");
      log("INFO", "unpausing_casswap");
      const unpauseTx = await casSwap.unpause();
      await unpauseTx.wait();
      log("INFO", "casswap_unpaused", { tx: unpauseTx.hash });
    }

    log("INFO", "withdrawing_cas", { amount: fmtCAS(swapCasBalance), to: INFRASTRUCTURE_FUND_ADDRESS });
    const withdrawCasTx = await casSwap.withdrawCAS(INFRASTRUCTURE_FUND_ADDRESS, swapCasBalance);
    await withdrawCasTx.wait();
    log("INFO", "withdraw_cas_confirmed", { tx: withdrawCasTx.hash });

    if (wasPaused) {
      log("INFO", "repausing_casswap");
      const pauseTx = await casSwap.pause();
      await pauseTx.wait();
      log("INFO", "casswap_repaused", { tx: pauseTx.hash });
    }
  }

  if (swapPolBalance > 0n) {
    log("INFO", "withdrawing_pol", { amount: fmtPOL(swapPolBalance) });
    const withdrawPolTx = await casSwap.withdrawPOL(swapPolBalance);
    await withdrawPolTx.wait();
    log("INFO", "withdraw_pol_confirmed", { tx: withdrawPolTx.hash });
  }

  // ------------------------------------------------------------------
  // Step 2: InfrastructureFund -> Rapport (Deployer)
  // ------------------------------------------------------------------
  const infraCasReceived = await casToken.balanceOf(INFRASTRUCTURE_FUND_ADDRESS);
  const infraPolReceived = await ethers.provider.getBalance(INFRASTRUCTURE_FUND_ADDRESS);

  log("INFO", "infra_fund_balances_after_withdraw", { cas: fmtCAS(infraCasReceived), pol: fmtPOL(infraPolReceived) });

  // Withdraw only the amount that came from CASSwap, not the entire InfrastructureFund balance.
  if (swapCasBalance > 0n) {
    log("INFO", "transferring_cas_to_rapport", { amount: fmtCAS(swapCasBalance) });
    const tx = await infraFund.transferCasToRapport(swapCasBalance);
    await tx.wait();
    log("INFO", "transfer_cas_to_rapport_confirmed", { tx: tx.hash });
  }

  if (swapPolBalance > 0n) {
    log("INFO", "transferring_pol_to_rapport", { amount: fmtPOL(swapPolBalance) });
    const tx = await infraFund.transferNativeToRapport(swapPolBalance);
    await tx.wait();
    log("INFO", "transfer_pol_to_rapport_confirmed", { tx: tx.hash });
  }

  // ------------------------------------------------------------------
  // Step 3: Deployer -> Diamond
  // ------------------------------------------------------------------
  const deployerCasBalance = await casToken.balanceOf(signer.address);
  const deployerPolBalance = await ethers.provider.getBalance(signer.address);
  log("INFO", "deployer_balances_after_rapport", { cas: fmtCAS(deployerCasBalance), pol: fmtPOL(deployerPolBalance) });

  // We transfer exactly the CAS amount withdrawn from the old swap.
  if (swapCasBalance > 0n) {
    if (deployerCasBalance < swapCasBalance) {
      throw new Error(`Deployer CAS balance ${fmtCAS(deployerCasBalance)} is less than required ${fmtCAS(swapCasBalance)}`);
    }

    log("INFO", "transferring_cas_to_diamond", { amount: fmtCAS(swapCasBalance), to: DIAMOND_ADDRESS });
    const tx = await casToken.transfer(DIAMOND_ADDRESS, swapCasBalance);
    await tx.wait();
    log("INFO", "transfer_cas_to_diamond_confirmed", { tx: tx.hash });
  }

  if (swapPolBalance > 0n) {
    if (deployerPolBalance < swapPolBalance) {
      throw new Error(`Deployer POL balance ${fmtPOL(deployerPolBalance)} is less than required ${fmtPOL(swapPolBalance)}`);
    }

    log("INFO", "transferring_pol_to_diamond", { amount: fmtPOL(swapPolBalance), to: DIAMOND_ADDRESS });
    const tx = await signer.sendTransaction({ to: DIAMOND_ADDRESS, value: swapPolBalance });
    await tx.wait();
    log("INFO", "transfer_pol_to_diamond_confirmed", { tx: tx.hash });
  }

  // ------------------------------------------------------------------
  // Final verification
  // ------------------------------------------------------------------
  const finalSwapCas = await casToken.balanceOf(CAS_SWAP_ADDRESS);
  const finalSwapPol = await ethers.provider.getBalance(CAS_SWAP_ADDRESS);
  const finalDiamondCas = await casToken.balanceOf(DIAMOND_ADDRESS);
  const finalDiamondPol = await ethers.provider.getBalance(DIAMOND_ADDRESS);
  const finalDeployerCas = await casToken.balanceOf(signer.address);
  const finalDeployerPol = await ethers.provider.getBalance(signer.address);

  log("INFO", "final_balances", {
    casswap: { cas: fmtCAS(finalSwapCas), pol: fmtPOL(finalSwapPol) },
    diamond: { cas: fmtCAS(finalDiamondCas), pol: fmtPOL(finalDiamondPol) },
    deployer: { cas: fmtCAS(finalDeployerCas), pol: fmtPOL(finalDeployerPol) },
  });

  if (finalSwapCas !== 0n) throw new Error("CASSwap still holds CAS after migration");
  if (finalSwapPol !== 0n) throw new Error("CASSwap still holds POL after migration");

  log("INFO", "migration_completed");
}

main().catch((err) => {
  log("ERROR", "migration_failed", { error: (err as Error).message });
  console.error(err);
  process.exitCode = 1;
});
