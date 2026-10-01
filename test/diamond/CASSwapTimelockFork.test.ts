import { expect } from "chai";
import { ethers, network } from "hardhat";
import payload from "../../deployments/casswap-timelock-cut.json";

const SAFE = "0x1743abe1A64DAB3c81e394adb4e3B56ef05F0D26";
const OWNER = "0x8950dD90B86D72e3F03A6d47Fb25B92808d40c7a";
const DELAY = 172800;

const TIMELOCK_ABI = [
  "function schedule(address,uint256,bytes,bytes32,bytes32,uint256)",
  "function execute(address,uint256,bytes,bytes32,bytes32) payable",
  "function isOperationReady(bytes32) view returns(bool)",
];

describe("CASSwap timelock fork", function () {
  this.timeout(180_000);

  before(async function () {
    if (!process.env.HARDHAT_FORK_URL) this.skip();
  });

  it("transfers ownership, waits 48 hours and executes the prepared cut", async function () {
    const swap = await ethers.getContractAt("CASSwapUSDCPOLFacet", payload.diamond);
    const ownership = await ethers.getContractAt("OwnershipFacet", payload.diamond);
    const loupe = await ethers.getContractAt("DiamondLoupeFacet", payload.diamond);
    const stateBefore = {
      pol: await swap.getRatio(),
      usdc: await swap.getRatioUSDC(),
      polSell: await swap.getRatioSell(),
      usdcSell: await swap.getRatioUSDCSell(),
      reserves: await swap.getReserves(),
      fee: await swap.getSwapFeeBps(),
      paused: await swap.isSwapPaused(),
    };

    for (const address of [OWNER, SAFE]) {
      await network.provider.request({ method: "hardhat_impersonateAccount", params: [address] });
      await network.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
    }
    const owner = await ethers.getSigner(OWNER);
    const safe = await ethers.getSigner(SAFE);
    await ownership.connect(owner).transferOwnership.staticCall(payload.timelock);
    await (await ownership.connect(owner).transferOwnership(payload.timelock)).wait();
    expect(await ownership.owner()).to.equal(payload.timelock);

    const timelock = new ethers.Contract(payload.timelock, TIMELOCK_ABI, safe);
    const scheduleArgs = [
      payload.diamond,
      0,
      payload.cutCalldata,
      payload.predecessor,
      payload.salt,
      DELAY,
    ] as const;
    await timelock.schedule.staticCall(...scheduleArgs);
    await (await timelock.schedule(...scheduleArgs)).wait();
    expect(await timelock.isOperationReady(payload.operationId)).to.equal(false);

    await network.provider.send("evm_increaseTime", [DELAY]);
    await network.provider.send("evm_mine");
    expect(await timelock.isOperationReady(payload.operationId)).to.equal(true);
    await (await timelock.execute(payload.diamond, 0, payload.cutCalldata, payload.predecessor, payload.salt)).wait();

    for (const entry of [...payload.replaceSelectors, ...payload.addSelectors]) {
      expect(await loupe.facetAddress(entry.selector)).to.equal(payload.facet);
    }
    expect(await swap.getRatio()).to.deep.equal(stateBefore.pol);
    expect(await swap.getRatioUSDC()).to.deep.equal(stateBefore.usdc);
    expect(await swap.getRatioSell()).to.deep.equal(stateBefore.polSell);
    expect(await swap.getRatioUSDCSell()).to.deep.equal(stateBefore.usdcSell);
    expect(await swap.getReserves()).to.deep.equal(stateBefore.reserves);
    expect(await swap.getSwapFeeBps()).to.equal(stateBefore.fee);
    expect(await swap.isSwapPaused()).to.equal(stateBefore.paused);
  });
});
