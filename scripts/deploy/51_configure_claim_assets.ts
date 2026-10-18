import { ethers, network } from "hardhat";

/**
 * @file 51_configure_claim_assets.ts
 * @description Configura suporte ao token CAS (CAS_TOKEN_ADDRESS) no
 *              ClaimVaultFacet do Diamond e, opcionalmente, ativa a promoção
 *              de gas VOUCHER_CLAIM (tipo 5) via GasPromotionFacet quando
 *              VOUCHER_PROMO_BUDGET_WEI estiver definido.
 *              Requer DIAMOND_ADDRESS e CAS_TOKEN_ADDRESS.
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

const VOUCHER_CLAIM_OPERATION = 5;

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [51_configure_claim_assets:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

async function main(): Promise<void> {
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  const casToken = process.env.CAS_TOKEN_ADDRESS;
  if (!diamondAddress || !ethers.isAddress(diamondAddress)) {
    throw new Error("DIAMOND_ADDRESS is required and must be a valid address");
  }
  if (!casToken || !ethers.isAddress(casToken)) {
    throw new Error("CAS_TOKEN_ADDRESS is required and must be a valid address");
  }

  const vault = await ethers.getContractAt("ClaimVaultFacet", diamondAddress);
  if (!(await vault.isClaimAssetSupported(casToken))) {
    const tx = await vault.setClaimAssetSupport(casToken, true);
    await tx.wait();
    log("info", "asset_enabled", `asset=${casToken} tx=${tx.hash}`);
  } else {
    log("info", "asset_already_enabled", `asset=${casToken}`);
  }

  const promoBudget = process.env.VOUCHER_PROMO_BUDGET_WEI;
  if (promoBudget) {
    const gasPromotion = await ethers.getContractAt("GasPromotionFacet", diamondAddress);
    const perUserLimit = process.env.VOUCHER_PROMO_PER_USER_WEI ?? promoBudget;
    const duration = process.env.VOUCHER_PROMO_DURATION_SECONDS ?? "2592000";
    const tx = await gasPromotion.activatePromotion(
      VOUCHER_CLAIM_OPERATION,
      BigInt(promoBudget),
      BigInt(perUserLimit),
      BigInt(duration),
    );
    await tx.wait();
    log("info", "promotion_activated", `operation=VOUCHER_CLAIM tx=${tx.hash} budget=${promoBudget}`);
  }

  const [balance, committed] = await vault.getVaultBalance(casToken);
  log("info", "vault_state", `network=${network.name} casBalance=${balance} committed=${committed}`);
}

main().catch((error) => {
  log("error", "configure_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
