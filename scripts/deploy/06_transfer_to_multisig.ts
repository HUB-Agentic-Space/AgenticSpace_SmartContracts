import { ethers } from "hardhat";
import {
  preFlightCheck, sendAndVerify, printSummary, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Transfer admin roles to a Safe multisig.
 *
 * Transfers DEFAULT_ADMIN_ROLE, MINTER_ROLE, PAUSER_ROLE, RATIO_ADMIN_ROLE
 * from the deployer to a Safe (Gnosis Safe) multisig address.
 *
 * Also transfers InfrastructureFund TREASURER_ROLE and ownership of
 * LiquidityLock and FundTrackerToken contracts.
 *
 * Prerequisites:
 *   - All contracts deployed
 *   - Safe multisig created on Polygon (set MULTISIG_ADDRESS in .env)
 *
 * Environment variables:
 *   - MULTISIG_ADDRESS: Safe multisig address
 *   - CAS_TOKEN_ADDRESS: CASToken proxy address
 *   - INFRASTRUCTURE_FUND_ADDRESS: InfrastructureFund proxy address
 *   - CAS_SWAP_ADDRESS: CASSwap proxy address (optional)
 *   - LP_LOCK_ADDRESS: LiquidityLock address (optional)
 */

async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["MULTISIG_ADDRESS"]);
  const multisigAddr = env.MULTISIG_ADDRESS;

  // Count how many grantRole calls we'll make
  const casTokenAddr = process.env.CAS_TOKEN_ADDRESS;
  const infraFundAddr = process.env.INFRASTRUCTURE_FUND_ADDRESS;
  const casSwapAddr = process.env.CAS_SWAP_ADDRESS;
  const lpLockAddr = process.env.LP_LOCK_ADDRESS;

  let roleCount = 0;
  if (casTokenAddr) roleCount += 4; // DEFAULT_ADMIN, MINTER, PAUSER, RATIO_ADMIN
  if (infraFundAddr) roleCount += 4; // DEFAULT_ADMIN, TREASURER, setRapport, setAuthor
  if (casSwapAddr) roleCount += 4; // DEFAULT_ADMIN, RATIO_ADMIN, TREASURER, PAUSER
  if (lpLockAddr) roleCount += 1; // transferOwnership

  const steps = [
    { label: `Grant roles (${roleCount} calls)`, gas: BigInt(roleCount) * 80_000n },
  ];

  const { gasPrice, balance } = await preFlightCheck(
    "Transfer Roles to Multisig",
    steps,
    {
      extraInfo: [
        { label: "Multisig:", value: multisigAddr },
        { label: "CASToken:", value: casTokenAddr || "(nao definido)" },
        { label: "InfraFund:", value: infraFundAddr || "(nao definido)" },
        { label: "CASSwap:", value: casSwapAddr || "(nao definido)" },
        { label: "LiquidityLock:", value: lpLockAddr || "(nao definido)" },
      ],
    },
  );

  // 1. Transfer CASToken roles
  if (casTokenAddr) {
    const casToken = await ethers.getContractAt("CASToken", casTokenAddr);
    const DEFAULT_ADMIN_ROLE = await casToken.DEFAULT_ADMIN_ROLE();
    const MINTER_ROLE = await casToken.MINTER_ROLE();
    const PAUSER_ROLE = await casToken.PAUSER_ROLE();
    const RATIO_ADMIN_ROLE = await casToken.RATIO_ADMIN_ROLE();

    await sendAndVerify("CASToken: grantRole(DEFAULT_ADMIN)", casToken.grantRole(DEFAULT_ADMIN_ROLE, multisigAddr, { gasPrice }), gasPrice);
    await sendAndVerify("CASToken: grantRole(MINTER)", casToken.grantRole(MINTER_ROLE, multisigAddr, { gasPrice }), gasPrice);
    await sendAndVerify("CASToken: grantRole(PAUSER)", casToken.grantRole(PAUSER_ROLE, multisigAddr, { gasPrice }), gasPrice);
    await sendAndVerify("CASToken: grantRole(RATIO_ADMIN)", casToken.grantRole(RATIO_ADMIN_ROLE, multisigAddr, { gasPrice }), gasPrice);
    console.log(`  CASToken: roles concedidos. Renuncie roles do deployer manualmente.\n`);
  }

  // 2. Transfer InfrastructureFund roles
  if (infraFundAddr) {
    const infraFund = await ethers.getContractAt("InfrastructureFund", infraFundAddr);
    const TREASURER_ROLE = await infraFund.TREASURER_ROLE();
    const DEFAULT_ADMIN_ROLE = await infraFund.DEFAULT_ADMIN_ROLE();

    await sendAndVerify("InfraFund: grantRole(DEFAULT_ADMIN)", infraFund.grantRole(DEFAULT_ADMIN_ROLE, multisigAddr, { gasPrice }), gasPrice);
    await sendAndVerify("InfraFund: grantRole(TREASURER)", infraFund.grantRole(TREASURER_ROLE, multisigAddr, { gasPrice }), gasPrice);
    await sendAndVerify("InfraFund: setRapportAddress", infraFund.setRapportAddress(multisigAddr, { gasPrice }), gasPrice);
    await sendAndVerify("InfraFund: setAuthorAddress", infraFund.setAuthorAddress(multisigAddr, { gasPrice }), gasPrice);
    console.log(`  InfraFund: roles concedidos. Renuncie roles do deployer manualmente.\n`);
  }

  // 3. Transfer CASSwap roles
  if (casSwapAddr) {
    const casSwap = await ethers.getContractAt("CASSwap", casSwapAddr);
    const DEFAULT_ADMIN_ROLE = await casSwap.DEFAULT_ADMIN_ROLE();
    const RATIO_ADMIN_ROLE = await casSwap.RATIO_ADMIN_ROLE();
    const TREASURER_ROLE = await casSwap.TREASURER_ROLE();
    const PAUSER_ROLE = await casSwap.PAUSER_ROLE();

    await sendAndVerify("CASSwap: grantRole(DEFAULT_ADMIN)", casSwap.grantRole(DEFAULT_ADMIN_ROLE, multisigAddr, { gasPrice }), gasPrice);
    await sendAndVerify("CASSwap: grantRole(RATIO_ADMIN)", casSwap.grantRole(RATIO_ADMIN_ROLE, multisigAddr, { gasPrice }), gasPrice);
    await sendAndVerify("CASSwap: grantRole(TREASURER)", casSwap.grantRole(TREASURER_ROLE, multisigAddr, { gasPrice }), gasPrice);
    await sendAndVerify("CASSwap: grantRole(PAUSER)", casSwap.grantRole(PAUSER_ROLE, multisigAddr, { gasPrice }), gasPrice);
    console.log(`  CASSwap: todos os roles concedidos ao multisig.\n`);
  }

  // 4. Transfer LiquidityLock ownership
  if (lpLockAddr) {
    const lpLock = await ethers.getContractAt("LiquidityLock", lpLockAddr);
    await sendAndVerify("LiquidityLock: transferOwnership", lpLock.transferOwnership(multisigAddr, { gasPrice }), gasPrice);
  }

  await printSummary(
    "Transfer Multisig Concluido",
    [
      { label: "Multisig:", value: multisigAddr },
    ],
    balance,
    [
      `IMPORTANTE: Renuncie roles do deployer manualmente apos verificar o multisig`,
    ],
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
