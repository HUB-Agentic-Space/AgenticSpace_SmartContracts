import { ethers } from "hardhat";
import { sendAndVerify, requireEnv } from "../utils/deploy_helpers";

/**
 * Test withdrawal from Infrastructure Fund.
 *
 * Environment variables:
 *   - INFRASTRUCTURE_FUND_ADDRESS: Fund contract address
 *   - FUND_WITHDRAW_CAS: Amount of CAS to withdraw (optional)
 *   - FUND_WITHDRAW_POL: Amount of POL to withdraw (optional)
 *
 * Usage:
 *   FUND_WITHDRAW_CAS=1 npx hardhat run scripts/deploy/08_withdraw_from_fund.ts --network polygon
 */

async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["INFRASTRUCTURE_FUND_ADDRESS"]);
  const fundAddr = env.INFRASTRUCTURE_FUND_ADDRESS;
  const casWithdraw = process.env.FUND_WITHDRAW_CAS
    ? ethers.parseEther(process.env.FUND_WITHDRAW_CAS)
    : 0n;
  const polWithdraw = process.env.FUND_WITHDRAW_POL
    ? ethers.parseEther(process.env.FUND_WITHDRAW_POL)
    : 0n;

  if (casWithdraw === 0n && polWithdraw === 0n) {
    console.log("\n  Erro: Defina FUND_WITHDRAW_CAS e/ou FUND_WITHDRAW_POL");
    console.log("  Exemplo: FUND_WITHDRAW_CAS=1");
    process.exit(1);
  }

  const gasPrice = (await ethers.provider.getFeeData()).gasPrice!;

  const fund = await ethers.getContractAt(
    [
      "function transferCasToRapport(uint256) external",
      "function transferNativeToRapport(uint256) external",
      "function casBalance() view returns (uint256)",
      "function nativeBalance() view returns (uint256)",
      "function rapportAddress() view returns (address)",
    ],
    fundAddr,
  );

  const rapport = await fund.rapportAddress();
  console.log(`\n  Fund: ${fundAddr}`);
  console.log(`  Rapport (destino): ${rapport}`);
  console.log(`  CAS withdraw: ${ethers.formatEther(casWithdraw)}`);
  console.log(`  POL withdraw: ${ethers.formatEther(polWithdraw)}`);
  console.log(`  Gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei\n`);

  if (casWithdraw > 0n) {
    await sendAndVerify(
      `transferCasToRapport(${ethers.formatEther(casWithdraw)} CAS)`,
      fund.transferCasToRapport(casWithdraw, { gasPrice }),
      gasPrice,
    );
  }

  if (polWithdraw > 0n) {
    await sendAndVerify(
      `transferNativeToRapport(${ethers.formatEther(polWithdraw)} POL)`,
      fund.transferNativeToRapport(polWithdraw, { gasPrice }),
      gasPrice,
    );
  }

  const casBal = await fund.casBalance();
  const nativeBal = await fund.nativeBalance();

  console.log(`\n  Fund balances apos saque:`);
  console.log(`    CAS: ${ethers.formatEther(casBal)}`);
  console.log(`    POL: ${ethers.formatEther(nativeBal)}`);
  console.log(`\n  Trackers no MetaMask: aCAS=${ethers.formatEther(casBal)}, aPOL=${ethers.formatEther(nativeBal)}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
