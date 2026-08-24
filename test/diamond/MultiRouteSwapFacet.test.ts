import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

describe("MultiRouteSwapFacet", function () {
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;
  let diamond: any;
  let facet: any;
  let mockRouter: any;
  let casToken: any;
  let wpolToken: any;
  let wethToken: any;

  const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
  const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

  before(async function () {
    [deployer, user] = await ethers.getSigners();

    // Deploy mock ERC20 tokens
    const TokenFactory = await ethers.getContractFactory("MockERC20");
    casToken = await TokenFactory.deploy("CAS Token", "CAS", 18);
    wpolToken = await TokenFactory.deploy("Wrapped POL", "WPOL", 18);
    wethToken = await TokenFactory.deploy("Wrapped ETH", "WETH", 18);

    // Deploy mock router
    const MockRouterFactory = await ethers.getContractFactory("MockV2Router");
    mockRouter = await MockRouterFactory.deploy();

    // Deploy MultiRouteSwapFacet
    const FacetFactory = await ethers.getContractFactory("MultiRouteSwapFacet");
    facet = await FacetFactory.deploy();

    // Deploy Diamond with the facet
    const DiamondFactory = await ethers.getContractFactory("Diamond");
    const selectors = facet.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => facet.interface.getFunction(f.name)!.selector)
      .filter((s: string) => s !== "0x00000000");

    const cut = [
      {
        facetAddress: await facet.getAddress(),
        action: 0,
        functionSelectors: selectors,
      },
    ];

    diamond = await DiamondFactory.deploy(deployer.address, cut);

    // Initialize
    const facetViaDiamond = await ethers.getContractAt(
      "MultiRouteSwapFacet",
      await diamond.getAddress(),
    );
    await facetViaDiamond.initMultiRouteSwap(await casToken.getAddress());
  });

  describe("Route management", function () {
    it("should add a route", async function () {
      const casAddr = await casToken.getAddress();
      const wethAddr = await wethToken.getAddress();
      const wpolAddr = await wpolToken.getAddress();
      const routerAddr = await mockRouter.getAddress();

      const hops = [
        {
          router: routerAddr,
          path: [casAddr, wethAddr],
          useNativeIn: false,
          useNativeOut: false,
          amountIn: ethers.parseEther("100"),
        },
        {
          router: routerAddr,
          path: [wethAddr, wpolAddr],
          useNativeIn: false,
          useNativeOut: false,
          amountIn: 0,
        },
        {
          router: routerAddr,
          path: [wpolAddr, casAddr],
          useNativeIn: false,
          useNativeOut: false,
          amountIn: 0,
        },
      ];

      const facetViaDiamond = await ethers.getContractAt(
        "MultiRouteSwapFacet",
        await diamond.getAddress(),
      );

      await expect(facetViaDiamond.addRoute("dfyn_to_apeswap", hops))
        .to.emit(facetViaDiamond, "RouteAdded")
        .withArgs("dfyn_to_apeswap", 3);
    });

    it("should list routes", async function () {
      const facetViaDiamond = await ethers.getContractAt(
        "MultiRouteSwapFacet",
        await diamond.getAddress(),
      );
      const routes = await facetViaDiamond.listRoutes();
      expect(routes).to.include("dfyn_to_apeswap");
    });

    it("should get route by name", async function () {
      const facetViaDiamond = await ethers.getContractAt(
        "MultiRouteSwapFacet",
        await diamond.getAddress(),
      );
      const route = await facetViaDiamond.getRoute("dfyn_to_apeswap");
      expect(route.name).to.equal("dfyn_to_apeswap");
      expect(route.active).to.be.true;
      expect(route.hops.length).to.equal(3);
    });

    it("should toggle route active state", async function () {
      const facetViaDiamond = await ethers.getContractAt(
        "MultiRouteSwapFacet",
        await diamond.getAddress(),
      );
      await facetViaDiamond.setRouteActive("dfyn_to_apeswap", false);
      const route = await facetViaDiamond.getRoute("dfyn_to_apeswap");
      expect(route.active).to.be.false;
    });

    it("should revert on non-existent route", async function () {
      const facetViaDiamond = await ethers.getContractAt(
        "MultiRouteSwapFacet",
        await diamond.getAddress(),
      );
      await expect(facetViaDiamond.getRoute("nonexistent"))
        .to.be.revertedWithCustomError(facetViaDiamond, "RouteNotFound");
    });

    it("should remove a route", async function () {
      const facetViaDiamond = await ethers.getContractAt(
        "MultiRouteSwapFacet",
        await diamond.getAddress(),
      );
      await facetViaDiamond.removeRoute("dfyn_to_apeswap");
      const routes = await facetViaDiamond.listRoutes();
      expect(routes).to.not.include("dfyn_to_apeswap");
    });
  });

  describe("Access control", function () {
    it("should revert when non-owner calls addRoute", async function () {
      const facetViaDiamond = await ethers.getContractAt(
        "MultiRouteSwapFacet",
        await diamond.getAddress(),
      );
      await expect(
        facetViaDiamond.connect(user).addRoute("test", []),
      ).to.be.revertedWithCustomError(facet, "NotContractOwner");
    });
  });
});
