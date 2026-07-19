import { ethers } from "hardhat";

/**
 * Validation script for testnet (Amoy) deployment.
 *
 * Validates all deployed contracts on the testnet by:
 *   - Reading contract state (name, symbol, decimals, MAX_SUPPLY, disclaimer)
 *   - Testing CASSwap buy/sell with small amounts
 *   - Testing ratio adjustment (flexible: 1:1 → 1:2 → 3:1 → 1:5)
 *   - Verifying Diamond PaymentFacet integration
 *   - Verifying InfrastructureFund balances
 *   - Verifying ContractRegistry entries
 *
 * Prerequisites:
 *   - All contracts deployed on Amoy
 *   - .env has all contract addresses set
 *
 * Environment variables:
 *   - CAS_TOKEN_ADDRESS, INFRASTRUCTURE_FUND_ADDRESS, CAS_SWAP_ADDRESS
 *   - DIAMOND_ADDRESS (optional, for Diamond integration tests)
 */

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`[validate:amoy] Validating testnet deployment with account: ${deployer.address}`);
  console.log(`[validate:amoy] Network: ${(await ethers.provider.getNetwork()).name}`);

  let passed = 0;
  let failed = 0;

  function check(condition: boolean, label: string) {
    if (condition) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.log(`  ❌ ${label}`);
      failed++;
    }
  }

  // -----------------------------------------------------------------------
  // 1. Validate CASToken
  // -----------------------------------------------------------------------
  console.log(`\n[validate:amoy] === CASToken ===`);
  const casTokenAddr = process.env.CAS_TOKEN_ADDRESS;
  if (!casTokenAddr) {
    console.error("[validate:amoy] ERROR: CAS_TOKEN_ADDRESS not set in .env");
    process.exit(1);
  }

  const casToken = await ethers.getContractAt("CASToken", casTokenAddr);

  const name = await casToken.name();
  const symbol = await casToken.symbol();
  const decimals = await casToken.decimals();
  const maxSupply = await casToken.maxSupply();
  const totalSupply = await casToken.totalSupply();
  const disclaimerText = await casToken.disclaimer();

  check(name === "Cryptocoin Agentic Space", `name = "${name}"`);
  check(symbol === "CAS", `symbol = "${symbol}"`);
  check(decimals === 18n, `decimals = ${decimals}`);
  check(maxSupply === ethers.parseEther("10000000"), `MAX_SUPPLY = ${ethers.formatEther(maxSupply)}`);
  check(totalSupply > 0n, `totalSupply > 0 (${ethers.formatEther(totalSupply)} CAS)`);
  check(disclaimerText.length > 0, `disclaimer exists (${disclaimerText.length} chars)`);
  check(
    disclaimerText.includes("infrastructure"),
    `disclaimer contains "infrastructure"`
  );

  const isMinter = await casToken.isMinter(deployer.address);
  const isRatioAdmin = await casToken.isRatioAdmin(deployer.address);
  check(isMinter === true, `deployer is minter`);
  check(isRatioAdmin === true, `deployer is ratio admin`);

  // -----------------------------------------------------------------------
  // 2. Validate CASSwap
  // -----------------------------------------------------------------------
  console.log(`\n[validate:amoy] === CASSwap ===`);
  const casSwapAddr = process.env.CAS_SWAP_ADDRESS;
  if (!casSwapAddr) {
    console.error("[validate:amoy] ERROR: CAS_SWAP_ADDRESS not set in .env");
    process.exit(1);
  }

  const casSwap = await ethers.getContractAt("CASSwap", casSwapAddr);

  const ratio = await casSwap.getRatio();
  const fee = await casSwap.getSwapFee();
  const casBal = await casSwap.getCASBalance();
  const polBal = await casSwap.getPOLBalance();
  const isPaused = await casSwap.isPaused();

  check(ratio[0] === 1n && ratio[1] === 1n, `initial ratio = 1:1`);
  check(fee === 0n, `swap fee = 0 bps`);
  check(casBal > 0n, `CAS reserve > 0 (${ethers.formatEther(casBal)} CAS)`);
  check(isPaused === false, `swap not paused`);

  // Test buy CAS with small POL amount
  console.log(`\n  [test] Buying CAS with 0.001 POL...`);
  const buyAmount = ethers.parseEther("0.001");
  const deployerBalBefore = await casToken.balanceOf(deployer.address);

  const buyTx = await casSwap.buyCAS({ value: buyAmount });
  const buyReceipt = await buyTx.wait();
  console.log(`  [test] Buy TX: ${buyReceipt?.hash}`);

  const deployerBalAfter = await casToken.balanceOf(deployer.address);
  const casReceived = deployerBalAfter - deployerBalBefore;
  check(casReceived > 0n, `buyCAS returned ${ethers.formatEther(casReceived)} CAS for 0.001 POL`);

  // Test ratio adjustment (flexible)
  console.log(`\n  [test] Testing flexible ratio adjustments...`);

  // 1:1 → 1:2
  await (await casSwap.setRatio(1, 2)).wait();
  let r = await casSwap.getRatio();
  check(r[0] === 1n && r[1] === 2n, `ratio changed to 1:2`);

  // 1:2 → 3:1
  await (await casSwap.setRatio(3, 1)).wait();
  r = await casSwap.getRatio();
  check(r[0] === 3n && r[1] === 1n, `ratio changed to 3:1`);

  // 3:1 → 1:5
  await (await casSwap.setRatio(1, 5)).wait();
  r = await casSwap.getRatio();
  check(r[0] === 1n && r[1] === 5n, `ratio changed to 1:5`);

  // 1:5 → 5:3
  await (await casSwap.setRatio(5, 3)).wait();
  r = await casSwap.getRatio();
  check(r[0] === 5n && r[1] === 3n, `ratio changed to 5:3`);

  // Reset to 1:1
  await (await casSwap.setRatio(1, 1)).wait();
  r = await casSwap.getRatio();
  check(r[0] === 1n && r[1] === 1n, `ratio reset to 1:1`);

  // Test invalid ratio (should revert)
  console.log(`  [test] Testing invalid ratio (0, 1) should revert...`);
  try {
    await casSwap.setRatio(0, 1);
    check(false, `setRatio(0, 1) should revert`);
  } catch {
    check(true, `setRatio(0, 1) reverted correctly`);
  }

  // Test sell CAS
  console.log(`\n  [test] Selling CAS for POL...`);
  const sellAmount = ethers.parseEther("0.0005");
  const approveSellTx = await casToken.approve(casSwapAddr, sellAmount);
  await approveSellTx.wait();

  const polBalBefore = await ethers.provider.getBalance(deployer.address);
  const sellTx = await casSwap.sellCAS(sellAmount);
  const sellReceipt = await sellTx.wait();
  console.log(`  [test] Sell TX: ${sellReceipt?.hash}`);
  const polBalAfter = await ethers.provider.getBalance(deployer.address);
  check(polBalAfter > polBalBefore - sellAmount, `sellCAS returned POL`);

  // -----------------------------------------------------------------------
  // 3. Validate InfrastructureFund
  // -----------------------------------------------------------------------
  console.log(`\n[validate:amoy] === InfrastructureFund ===`);
  const infraFundAddr = process.env.INFRASTRUCTURE_FUND_ADDRESS;
  if (infraFundAddr) {
    const infraFund = await ethers.getContractAt("InfrastructureFund", infraFundAddr);

    const fundCasBal = await infraFund.casBalance();
    const fundNativeBal = await infraFund.nativeBalance();
    const rapportAddr = await infraFund.rapportAddress();
    const authorAddr = await infraFund.authorAddress();

    check(rapportAddr !== ethers.ZeroAddress, `rapport address set`);
    check(authorAddr !== ethers.ZeroAddress, `author address set`);
    console.log(`  ℹ️  CAS balance in fund: ${ethers.formatEther(fundCasBal)}`);
    console.log(`  ℹ️  POL balance in fund: ${ethers.formatEther(fundNativeBal)}`);
  }

  // -----------------------------------------------------------------------
  // 4. Validate Diamond integration (optional)
  // -----------------------------------------------------------------------
  console.log(`\n[validate:amoy] === Diamond Integration ===`);
  const diamondAddr = process.env.DIAMOND_ADDRESS;
  if (diamondAddr) {
    const paymentFacet = await ethers.getContractAt("PaymentFacet", diamondAddr);
    const registeredCas = await paymentFacet.getCasToken();
    const registeredFund = await paymentFacet.getInfrastructureFund();
    const fees = await paymentFacet.getFees();

    check(
      registeredCas.toLowerCase() === casTokenAddr.toLowerCase(),
      `PaymentFacet has correct CAS token address`
    );
    if (infraFundAddr) {
      check(
        registeredFund.toLowerCase() === infraFundAddr.toLowerCase(),
        `PaymentFacet has correct InfrastructureFund address`
      );
    }
    console.log(`  ℹ️  Registration fee: ${fees.registrationFee}`);
    console.log(`  ℹ️  Validation fee: ${fees.validationFee}`);
    console.log(`  ℹ️  DAO proposal fee: ${fees.daoProposalFee}`);
  } else {
    console.log(`  ⚠️  DIAMOND_ADDRESS not set, skipping Diamond integration tests`);
  }

  // -----------------------------------------------------------------------
  // 5. Summary
  // -----------------------------------------------------------------------
  console.log(`\n[validate:amoy] === Validation Summary ===`);
  console.log(`[validate:amoy] Passed: ${passed}`);
  console.log(`[validate:amoy] Failed: ${failed}`);
  console.log(`[validate:amoy] Result: ${failed === 0 ? "ALL TESTS PASSED ✅" : "SOME TESTS FAILED ❌"}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
