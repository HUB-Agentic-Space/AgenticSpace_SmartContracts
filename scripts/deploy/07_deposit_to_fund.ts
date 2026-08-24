import { ethers } from "hardhat";
import { sendAndVerify, printSummary, requireEnv } from "../utils/deploy_helpers";

/**
 * Deposit CAS and/or POL into the Infrastructure Fund.
 *
 * Environment variables:
 *   - INFRASTRUCTURE_FUND_ADDRESS: Fund contract address
 *   - CAS_TOKEN_ADDRESS: CAS token address
 *   - FUND_DEPOSIT_CAS: Amount of CAS to deposit (optional, default: 0)
 *   - FUND_DEPOSIT_POL: Amount of POL to deposit (optional, default: 0)
 *
 * Usage:
 *   FUND_DEPOSIT_CAS=100 FUND_DEPOSIT_POL=10 npx hardhat run scripts/deploy/07_deposit_to_fund.ts --network polygon
 */

async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["INFRASTRUCTURE_FUND_ADDRESS", "CAS_TOKEN_ADDRESS"]);
  const fundAddr = env.INFRASTRUCTURE_FUND_ADDRESS;
  const casTokenAddr = env.CAS_TOKEN_ADDRESS;
  const casAmount = process.env.FUND_DEPOSIT_CAS
    ? ethers.parseEther(process.env.FUND_DEPOSIT_CAS)
    : 0n;
  const polAmount = process.env.FUND_DEPOSIT_POL
    ? ethers.parseEther(process.env.FUND_DEPOSIT_POL)
    : 0n;

  if (casAmount === 0n && polAmount === 0n) {
    console.log("\n  Erro: Defina FUND_DEPOSIT_CAS e/ou FUND_DEPOSIT_POL no .env");
    console.log("  Exemplo: FUND_DEPOSIT_CAS=100 FUND_DEPOSIT_POL=10");
    process.exit(1);
  }

  const gasPrice = (await ethers.provider.getFeeData()).gasPrice!;
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`\n  Fund: ${fundAddr}`);
  console.log(`  CAS deposit: ${ethers.formatEther(casAmount)}`);
  console.log(`  POL deposit: ${ethers.formatEther(polAmount)}`);
  console.log(`  Saldo: ${ethers.formatEther(balance)} POL`);
  console.log(`  Gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei\n`);

  const fund = await ethers.getContractAt(
    [
      "function depositCas(uint256) external",
      "function depositNative() external payable",
      "function casBalance() view returns (uint256)",
      "function nativeBalance() view returns (uint256)",
    ],
    fundAddr,
  );

  // Step 1: Deposit CAS
  if (casAmount > 0n) {
    const casToken = await ethers.getContractAt("CASToken", casTokenAddr);

    await sendAndVerify(
      `approve(${ethers.formatEther(casAmount)} CAS)`,
      casToken.approve(fundAddr, casAmount, { gasPrice }),
      gasPrice,
    );

    await sendAndVerify(
      `depositCas(${ethers.formatEther(casAmount)})`,
      fund.depositCas(casAmount, { gasPrice }),
      gasPrice,
    );
  }

  // Step 2: Deposit POL
  if (polAmount > 0n) {
    await sendAndVerify(
      `depositNative(${ethers.formatEther(polAmount)} POL)`,
      fund.depositNative({ value: polAmount, gasPrice }),
      gasPrice,
    );
  }

  // Verify balances
  const casBal = await fund.casBalance();
  const nativeBal = await fund.nativeBalance();

  console.log(`\n  Fund balances:`);
  console.log(`    CAS: ${ethers.formatEther(casBal)}`);
  console.log(`    POL: ${ethers.formatEther(nativeBal)}`);

  await printSummary(
    "Deposit to Fund Concluido",
    [
      { label: "Fund:", value: fundAddr },
      { label: "CAS deposited:", value: ethers.formatEther(casAmount) },
      { label: "POL deposited:", value: ethers.formatEther(polAmount) },
      { label: "Fund CAS balance:", value: ethers.formatEther(casBal) },
      { label: "Fund POL balance:", value: ethers.formatEther(nativeBal) },
    ],
    balance,
    [
      `Trackers no MetaMask: aCAS=${ethers.formatEther(casBal)}, aPOL=${ethers.formatEther(nativeBal)}`,
    ],
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
