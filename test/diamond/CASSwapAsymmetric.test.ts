import { expect } from "chai";
import { ethers } from "hardhat";

describe("CASSwap Asymmetric Ratios", function () {
  let diamond: any;
  let owner: any;
  let user: any;
  let casToken: any;
  let usdcToken: any;

  const SWAP_ABI = [
    "function initCASSwapUSDCPOL(address,address) external",
    "function setSwapRatio(uint256,uint256) external",
    "function setSwapRatioUSDC(uint256,uint256) external",
    "function setSwapRatioSell(uint256,uint256) external",
    "function setSwapRatioUSDCSell(uint256,uint256) external",
    "function getRatio() view returns (uint256,uint256)",
    "function getRatioUSDC() view returns (uint256,uint256)",
    "function getRatioSell() view returns (uint256,uint256)",
    "function getRatioUSDCSell() view returns (uint256,uint256)",
    "function buyCASWithPOL(uint256,uint256) payable returns (uint256)",
    "function sellCASForPOL(uint256,uint256,uint256) returns (uint256)",
    "function isSwapPaused() view returns (bool)",
  ];

  async function deployDiamond() {
    const LibDiamond = await ethers.getContractFactory("LibDiamond");
    const libDiamond = await LibDiamond.deploy();
    await libDiamond.waitForDeployment();

    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    const diamondCutFacet = await DiamondCutFacet.deploy();
    await diamondCutFacet.waitForDeployment();

    // Register DiamondCutFacet selectors in initial cut
    const cutFacetSelectors: string[] = [];
    diamondCutFacet.interface.forEachFunction((frag: any) => {
      cutFacetSelectors.push(frag.selector);
    });

    const initialCut = [{
      facetAddress: await diamondCutFacet.getAddress(),
      action: 0,
      functionSelectors: cutFacetSelectors,
    }];

    const Diamond = await ethers.getContractFactory("Diamond");
    const diamond = await Diamond.deploy(owner.address, initialCut);
    await diamond.waitForDeployment();

    const swapFacet = await ethers.getContractFactory("CASSwapUSDCPOLFacet");
    const swapFacetDeployed = await swapFacet.deploy();
    await swapFacetDeployed.waitForDeployment();

    const selectors: string[] = [];
    swapFacet.interface.forEachFunction((frag: any) => {
      selectors.push(frag.selector);
    });

    const cut = [{
      facetAddress: await swapFacetDeployed.getAddress(),
      action: 0,
      functionSelectors: selectors,
    }];

    const initCalldata = swapFacet.interface.encodeFunctionData("initCASSwapUSDCPOL", [
      await casToken.getAddress(),
      await usdcToken.getAddress(),
    ]);

    const diamondLoupe = new ethers.Contract(await diamond.getAddress(), [
      "function diamondCut((address facetAddress, uint8 action, bytes4[] functionSelectors)[], address initAddress, bytes initCalldata) external",
    ], owner);

    await (await diamondLoupe.diamondCut(cut, await swapFacetDeployed.getAddress(), initCalldata)).wait();

    return new ethers.Contract(await diamond.getAddress(), SWAP_ABI, owner);
  }

  before(async function () {
    [owner, user] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    casToken = await MockERC20.deploy("CAS Token", "CAS", 18);
    await casToken.waitForDeployment();

    usdcToken = await MockERC20.deploy("USDC", "USDC", 6);
    await usdcToken.waitForDeployment();

    diamond = await deployDiamond();

    await casToken.mint(await diamond.getAddress(), ethers.parseEther("1000000"));
    await owner.sendTransaction({
      to: await diamond.getAddress(),
      value: ethers.parseEther("100"),
    });
  });

  it("should set independent buy and sell ratios", async function () {
    // Buy: 1 POL = 1500 CAS (user gets fewer CAS per POL)
    await diamond.setSwapRatio(ethers.parseEther("1500"), ethers.parseEther("1"));
    // Sell: 1 POL = 2000 CAS (user needs more CAS to get 1 POL back)
    await diamond.setSwapRatioSell(ethers.parseEther("2000"), ethers.parseEther("1"));

    const [buyNum, buyDen] = await diamond.getRatio();
    expect(buyNum).to.equal(ethers.parseEther("1500"));
    expect(buyDen).to.equal(ethers.parseEther("1"));

    const [sellNum, sellDen] = await diamond.getRatioSell();
    expect(sellNum).to.equal(ethers.parseEther("2000"));
    expect(sellDen).to.equal(ethers.parseEther("1"));
  });

  it("should use buy ratio for buyCASWithPOL and sell ratio for sellCASForPOL", async function () {
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    // Buy: 1 POL should give 1500 CAS (fee=0, buy ratio)
    const casOut = await diamond.buyCASWithPOL.staticCall(0, deadline, {
      value: ethers.parseEther("1"),
    });
    expect(casOut).to.equal(ethers.parseEther("1500"));

    // Execute buy
    await diamond.buyCASWithPOL(0, deadline, { value: ethers.parseEther("1") });

    // Sell: 1500 CAS should give 1500/2000 = 0.75 POL (using sell ratio)
    const casIn = ethers.parseEther("1500");
    await casToken.mint(user.address, casIn);
    await casToken.connect(user).approve(await diamond.getAddress(), casIn);

    const polOut = await diamond.connect(user).sellCASForPOL.staticCall(casIn, 0, deadline);
    const expectedPol = (casIn * ethers.parseEther("1")) / ethers.parseEther("2000");
    expect(polOut).to.equal(expectedPol);

    // Verify spread: round-trip loses value (swap keeps the difference)
    // 1 POL → 1500 CAS → 0.75 POL → swap profits 0.25 POL
    expect(polOut).to.be.lt(ethers.parseEther("1"));
  });

  it("getRatioSell should fall back to buy ratio when sell ratio is 0", async function () {
    const freshDiamond = await deployDiamond();
    await freshDiamond.setSwapRatio(ethers.parseEther("1000"), ethers.parseEther("1"));

    const [sellNum, sellDen] = await freshDiamond.getRatioSell();
    expect(sellNum).to.equal(ethers.parseEther("1000"));
    expect(sellDen).to.equal(ethers.parseEther("1"));
  });
});
