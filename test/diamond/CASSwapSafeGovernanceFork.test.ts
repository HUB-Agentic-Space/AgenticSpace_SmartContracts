import { expect } from "chai";
import { ethers, network } from "hardhat";

const SAFE = "0x1743abe1A64DAB3c81e394adb4e3B56ef05F0D26";
const CURRENT_OWNER = "0x63cf627357A9C4C8EabA4b3d2d563dE825d71f25";
const OWNER_2 = "0x253174e88515beCB71444229BaC1461c26A5d5D7";
const OWNER_3 = "0x06aE104567Fe969ba57371940730111FaeD33E9a";

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function addOwnerWithThreshold(address owner, uint256 threshold)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address payable refundReceiver,bytes signatures) returns (bool)",
];

function prevalidatedSignature(owner: string): string {
  return ethers.solidityPacked(["bytes32", "uint256", "uint8"], [ethers.zeroPadValue(owner, 32), 0, 1]);
}

describe("CASSwap Safe governance fork", function () {
  this.timeout(180_000);

  before(async function () {
    if (!process.env.HARDHAT_FORK_URL) this.skip();
  });

  it("changes the existing Safe from 1-of-1 to 2-of-3", async function () {
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [CURRENT_OWNER] });
    await network.provider.send("hardhat_setBalance", [CURRENT_OWNER, "0x56BC75E2D63100000"]);
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [OWNER_2] });
    await network.provider.send("hardhat_setBalance", [OWNER_2, "0x56BC75E2D63100000"]);
    const signer1 = await ethers.getSigner(CURRENT_OWNER);
    const signer2 = await ethers.getSigner(OWNER_2);
    const safe = new ethers.Contract(SAFE, SAFE_ABI, signer1);

    expect(await safe.getThreshold()).to.equal(1n);
    expect(await safe.getOwners()).to.deep.equal([CURRENT_OWNER]);

    const data9 = safe.interface.encodeFunctionData("addOwnerWithThreshold", [OWNER_2, 1n]);
    const args9 = [SAFE, 0, data9, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, prevalidatedSignature(CURRENT_OWNER)] as const;
    await safe.execTransaction.staticCall(...args9);
    await (await safe.execTransaction(...args9)).wait();

    const safeAsOwner2 = safe.connect(signer2);
    const data10 = safe.interface.encodeFunctionData("addOwnerWithThreshold", [OWNER_3, 2n]);
    const args10 = [SAFE, 0, data10, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, prevalidatedSignature(OWNER_2)] as const;
    await safeAsOwner2.execTransaction.staticCall(...args10);
    await (await safeAsOwner2.execTransaction(...args10)).wait();

    const owners = (await safe.getOwners()).map((owner: string) => owner.toLowerCase());
    expect(owners).to.have.members([CURRENT_OWNER, OWNER_2, OWNER_3].map((owner) => owner.toLowerCase()));
    expect(await safe.getThreshold()).to.equal(2n);
  });
});
