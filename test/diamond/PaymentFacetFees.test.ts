import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("PaymentFacet fee catalog", () => {
  const PAUTA_SUBMISSION = 4n;
  const COMMUNITY_VOTING = 5n;
  const CERTIFICATE_ISSUANCE = 6n;
  const CERTIFICATE_RESERVE = ethers.parseEther("50");

  async function deployFixture() {
    const [owner, outsider] = await ethers.getSigners();
    const PaymentFacet = await ethers.getContractFactory("PaymentFacet");
    const paymentFacet = await PaymentFacet.deploy() as any;
    await paymentFacet.waitForDeployment();

    // A standalone facet needs the same LibDiamond owner slot that it sees
    // through delegatecall when attached to the Diamond.
    const baseSlot = ethers.keccak256(
      ethers.toUtf8Bytes("agentic.space.diamond.storage"),
    );
    const ownerSlot = ethers.toQuantity(BigInt(baseSlot) + 4n);
    await ethers.provider.send("hardhat_setStorageAt", [
      await paymentFacet.getAddress(),
      ownerSlot,
      ethers.zeroPadValue(owner.address, 32),
    ]);

    await paymentFacet.initPayment();
    return { owner, outsider, paymentFacet };
  }

  it("registers the 50 CAS certificate issuance reserve in the default catalog", async () => {
    const { paymentFacet } = await loadFixture(deployFixture);

    expect(await paymentFacet.isFeeTypeRegistered(CERTIFICATE_ISSUANCE)).to.be.true;
    expect(await paymentFacet.getCustomFee(CERTIFICATE_ISSUANCE)).to.equal(
      CERTIFICATE_RESERVE,
    );

    const [feeTypes, amounts] = await paymentFacet.getAllFeeTypes();
    expect(feeTypes).to.deep.equal([
      PAUTA_SUBMISSION,
      COMMUNITY_VOTING,
      CERTIFICATE_ISSUANCE,
    ]);
    expect(amounts).to.deep.equal([
      ethers.parseEther("10"),
      ethers.parseEther("50"),
      CERTIFICATE_RESERVE,
    ]);
  });

  it("does not duplicate catalog entries when defaults are initialized again", async () => {
    const { paymentFacet } = await loadFixture(deployFixture);

    await paymentFacet.initPayment();
    const [feeTypes] = await paymentFacet.getAllFeeTypes();

    expect(feeTypes.filter((feeType: bigint) => feeType === CERTIFICATE_ISSUANCE))
      .to.have.length(1);
  });

  it("keeps updates owner-only and bounded by MAX_FEE", async () => {
    const { outsider, paymentFacet } = await loadFixture(deployFixture);

    await expect(
      paymentFacet.connect(outsider).setCustomFee(
        CERTIFICATE_ISSUANCE,
        ethers.parseEther("60"),
      ),
    ).to.be.reverted;

    await expect(
      paymentFacet.setCustomFee(
        CERTIFICATE_ISSUANCE,
        ethers.parseEther("10001"),
      ),
    )
      .to.be.revertedWithCustomError(paymentFacet, "FeeTooHigh")
      .withArgs(ethers.parseEther("10001"), ethers.parseEther("10000"));
  });
});
