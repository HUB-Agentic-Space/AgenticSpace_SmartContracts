/**
 * Check Safe owners and threshold.
 *
 * Usage:
 *   npx hardhat run scripts/check_safe_owners.ts --network polygon
 */

import { ethers } from "hardhat";

async function main() {
  const safeImpl = "0x29fcb43b46531bca003ddc8fcb67ffe91900c762";
  const safeProxy = "0x1743abe1A64DAB3c81e394adb4e3B56ef05F0D26";

  // GnosisSafe ABI (minimal)
  const safeAbi = [
    "function getOwners() view returns (address[])",
    "function getThreshold() view returns (uint256)",
    "function nonce() view returns (uint256)",
  ];

  const safe = new ethers.Contract(safeProxy, safeAbi, ethers.provider);

  const owners = await safe.getOwners();
  const threshold = await safe.getThreshold();
  const nonce = await safe.nonce();

  console.log(`Safe proxy: ${safeProxy}`);
  console.log(`Safe implementation: ${safeImpl}`);
  console.log(`Threshold: ${threshold}`);
  console.log(`Nonce: ${nonce}`);
  console.log(`Owners (${owners.length}):`);
  for (const owner of owners) {
    const code = await ethers.provider.getCode(owner);
    console.log(`  ${owner} (${code === "0x" ? "EOA" : "CONTRACT"})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
