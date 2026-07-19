import { ethers } from "hardhat";

const FEE_TYPE_CERTIFICATE_ISSUANCE = 6n;
const CERTIFICATE_ISSUANCE_FEE = ethers.parseEther("50");

function normalizedPrivateKey(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

async function main() {
  const diamondAddress = process.env.DIAMOND_ADDRESS?.trim();
  if (!diamondAddress || !ethers.isAddress(diamondAddress)) {
    throw new Error("DIAMOND_ADDRESS must contain a valid Diamond proxy address.");
  }

  const [defaultSigner] = await ethers.getSigners();
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY?.trim();
  const signer = relayerPrivateKey
    ? new ethers.Wallet(normalizedPrivateKey(relayerPrivateKey), ethers.provider)
    : defaultSigner;

  const signerAddress = await signer.getAddress();
  const ownership = await ethers.getContractAt(
    "OwnershipFacet",
    diamondAddress,
    signer,
  ) as any;
  const owner = await ownership.owner();
  if (owner.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(
      `The selected signer (${signerAddress}) is not the Diamond owner (${owner}). ` +
      "Set RELAYER_PRIVATE_KEY to the owner key.",
    );
  }

  const payment = await ethers.getContractAt(
    "PaymentFacet",
    diamondAddress,
    signer,
  ) as any;

  const isRegistered = await payment.isFeeTypeRegistered(
    FEE_TYPE_CERTIFICATE_ISSUANCE,
  );
  let transactionHash: string | null = null;

  if (!isRegistered) {
    const tx = await payment.registerFeeType(
      FEE_TYPE_CERTIFICATE_ISSUANCE,
      CERTIFICATE_ISSUANCE_FEE,
    );
    transactionHash = tx.hash;
    await tx.wait();
  } else {
    const currentAmount = await payment.getCustomFee(
      FEE_TYPE_CERTIFICATE_ISSUANCE,
    );
    if (currentAmount !== CERTIFICATE_ISSUANCE_FEE) {
      const tx = await payment.setCustomFee(
        FEE_TYPE_CERTIFICATE_ISSUANCE,
        CERTIFICATE_ISSUANCE_FEE,
      );
      transactionHash = tx.hash;
      await tx.wait();
    }
  }

  const verifiedAmount = await payment.getCustomFee(
    FEE_TYPE_CERTIFICATE_ISSUANCE,
  );
  const [feeTypes] = await payment.getAllFeeTypes();
  const occurrences = feeTypes.filter(
    (feeType: bigint) => feeType === FEE_TYPE_CERTIFICATE_ISSUANCE,
  ).length;

  if (verifiedAmount !== CERTIFICATE_ISSUANCE_FEE || occurrences !== 1) {
    throw new Error(
      `Certificate fee verification failed: amount=${verifiedAmount}, occurrences=${occurrences}.`,
    );
  }

  console.log("[certificate-fee] Diamond:", diamondAddress);
  console.log("[certificate-fee] Fee type: 6");
  console.log("[certificate-fee] Amount: 50 CAS");
  console.log(
    "[certificate-fee] Transaction:",
    transactionHash ?? "unchanged (already configured)",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
