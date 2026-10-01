import { expect } from "chai";
import { ethers, network } from "hardhat";
import { IDiamondCut } from "../../typechain-types";

const DIAMOND = "0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b";
const OWNER = "0x8950dD90B86D72e3F03A6d47Fb25B92808d40c7a";

function selectorsOf(contract: any): string[] {
  const selectors: string[] = [];
  contract.interface.forEachFunction((fragment: any) => selectors.push(fragment.selector));
  return [...new Set(selectors)];
}

describe("CASSwap Polygon fork upgrade", function () {
  this.timeout(180_000);

  before(async function () {
    if (!process.env.HARDHAT_FORK_URL) this.skip();
  });

  it("replaces the facet while preserving Diamond storage", async function () {
    const [deployer] = await ethers.getSigners();
    const swapBefore = await ethers.getContractAt("CASSwapUSDCPOLFacet", DIAMOND);
    const loupe = await ethers.getContractAt("DiamondLoupeFacet", DIAMOND);
    const diamondCut = await ethers.getContractAt("IDiamondCut", DIAMOND);

    const stateBefore = {
      ratioPol: await swapBefore.getRatio(),
      ratioUsdc: await swapBefore.getRatioUSDC(),
      ratioPolSell: await swapBefore.getRatioSell(),
      ratioUsdcSell: await swapBefore.getRatioUSDCSell(),
      reserves: await swapBefore.getReserves(),
      fee: await swapBefore.getSwapFeeBps(),
      paused: await swapBefore.isSwapPaused(),
    };

    const factory = await ethers.getContractFactory("CASSwapUSDCPOLFacet", deployer);
    const newFacet = await factory.deploy();
    await newFacet.waitForDeployment();
    const newFacetAddress = await newFacet.getAddress();

    const replace: string[] = [];
    const add: string[] = [];
    for (const selector of selectorsOf(newFacet)) {
      const currentFacet = await loupe.facetAddress(selector);
      (currentFacet === ethers.ZeroAddress ? add : replace).push(selector);
    }

    const cuts: IDiamondCut.FacetCutStruct[] = [];
    if (replace.length > 0) cuts.push({ facetAddress: newFacetAddress, action: 1, functionSelectors: replace });
    if (add.length > 0) cuts.push({ facetAddress: newFacetAddress, action: 0, functionSelectors: add });

    await network.provider.request({ method: "hardhat_impersonateAccount", params: [OWNER] });
    await network.provider.send("hardhat_setBalance", [OWNER, "0x56BC75E2D63100000"]);
    const owner = await ethers.getSigner(OWNER);

    await diamondCut.connect(owner).diamondCut.staticCall(cuts, ethers.ZeroAddress, "0x");
    await (await diamondCut.connect(owner).diamondCut(cuts, ethers.ZeroAddress, "0x")).wait();

    for (const selector of [...replace, ...add]) {
      expect(await loupe.facetAddress(selector)).to.equal(newFacetAddress);
    }

    const swapAfter = await ethers.getContractAt("CASSwapUSDCPOLFacet", DIAMOND);
    expect(await swapAfter.getRatio()).to.deep.equal(stateBefore.ratioPol);
    expect(await swapAfter.getRatioUSDC()).to.deep.equal(stateBefore.ratioUsdc);
    expect(await swapAfter.getRatioSell()).to.deep.equal(stateBefore.ratioPolSell);
    expect(await swapAfter.getRatioUSDCSell()).to.deep.equal(stateBefore.ratioUsdcSell);
    expect(await swapAfter.getReserves()).to.deep.equal(stateBefore.reserves);
    expect(await swapAfter.getSwapFeeBps()).to.equal(stateBefore.fee);
    expect(await swapAfter.isSwapPaused()).to.equal(stateBefore.paused);
  });
});
