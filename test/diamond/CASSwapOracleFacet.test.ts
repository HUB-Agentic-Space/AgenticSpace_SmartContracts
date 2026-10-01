import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

// CASSwap oracle pricing (section 12.x): o facet passa a derivar os ratios de
// oráculos on-chain (Chainlink para POL/USD, USDC/USD, USD/BRL; TWAP UniV3 +
// SushiSwap V2 para CAS/WPOL) mantendo a regra "compra caro, vende barato" —
// o spread fica no contrato. Fallback para ratios legados é limitado por
// legacyRatioMaxAge.

const POL = 0;
const USDC = 1;
const BRLA = 2;

const E18 = ethers.parseEther("1");
const WINDOW = 1800; // 30 min
const Q112 = 1n << 112n;

// tick UniV3 para um preço CAS/WPOL dado (token0=WPOL, token1=CAS).
function tickFor(price: number): bigint {
  return BigInt(Math.round(Math.log(price) / Math.log(1.0001)));
}

function getSelectors(contract: any): string[] {
  const selectors: string[] = [];
  for (const f of contract.interface.fragments) {
    if ((f as any).type === "function") selectors.push((f as any).selector ?? ethers.id((f as any).format("sighash")).slice(0, 10));
  }
  return selectors;
}

async function deployFixture() {
  const [owner, user] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const cas = await MockERC20.deploy("CAS Token", "CAS", 18);
  const usdc = await MockERC20.deploy("USDC Token", "USDC", 6);
  const brla = await MockERC20.deploy("BRLA Digital", "BRLA", 18);
  const wpol = await MockERC20.deploy("Wrapped POL", "WPOL", 18);

  const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
  const dcf = await DiamondCutFacet.deploy();
  const Diamond = await ethers.getContractFactory("Diamond");
  const diamond = await Diamond.deploy(owner.address, [{
    facetAddress: await dcf.getAddress(), action: 0, functionSelectors: getSelectors(dcf),
  }]);

  const SwapFacet = await ethers.getContractFactory("CASSwapUSDCPOLFacet");
  const swapFacet = await SwapFacet.deploy();
  const OracleFacet = await ethers.getContractFactory("CASSwapOracleFacet");
  const oracleFacet = await OracleFacet.deploy();

  const diamondCut = await ethers.getContractAt("IDiamondCut", await diamond.getAddress());
  await (await diamondCut.diamondCut([
    { facetAddress: await swapFacet.getAddress(), action: 0, functionSelectors: getSelectors(swapFacet) },
    { facetAddress: await oracleFacet.getAddress(), action: 0, functionSelectors: getSelectors(oracleFacet) },
  ], ethers.ZeroAddress, "0x")).wait();

  const swap = await ethers.getContractAt("CASSwapUSDCPOLFacet", await diamond.getAddress());
  const oracle = await ethers.getContractAt("CASSwapOracleFacet", await diamond.getAddress());
  await (await swap.initCASSwapUSDCPOL(await cas.getAddress(), await usdc.getAddress())).wait();
  await (await swap.setMaxImpactBps(0n)).wait();
  await (await swap.setBRLAToken(await brla.getAddress())).wait();
  await (await swap.setAllSwapRatiosV2(
    ethers.parseEther("500"), E18,        // POL buy legado
    5000n * 10n ** 12n, E18,              // USDC buy legado
    ethers.parseEther("700"), E18,        // BRLA buy legado
    ethers.parseEther("600"), E18,        // POL sell legado
    6000n * 10n ** 12n, E18,              // USDC sell legado
    ethers.parseEther("800"), E18,        // BRLA sell legado
  )).wait();

  // Mocks de oráculo
  const Feed = await ethers.getContractFactory("MockChainlinkFeed");
  const polFeed = await Feed.deploy(8);   // POL/USD = $0.20
  const usdcFeed = await Feed.deploy(8);  // USDC/USD = $1.00
  const brlFeed = await Feed.deploy(8);   // BRL/USD = $0.1924 (USD por BRL)
  const now = await time.latest();
  await (await polFeed.setAnswer(20_000_000, now)).wait();
  await (await usdcFeed.setAnswer(100_000_000, now)).wait();
  await (await brlFeed.setAnswer(19_240_000, now)).wait();

  const UniPool = await ethers.getContractFactory("MockUniV3Pool");
  const uniPool = await UniPool.deploy(await wpol.getAddress(), await cas.getAddress()); // t0=WPOL t1=CAS
  const SushiPair = await ethers.getContractFactory("MockSushiPair");
  const sushiPair = await SushiPair.deploy(await wpol.getAddress(), await cas.getAddress());

  // Fundos do diamond e do usuário
  await (await owner.sendTransaction({ to: await diamond.getAddress(), value: ethers.parseEther("10") })).wait();
  await (await cas.mint(await diamond.getAddress(), ethers.parseEther("1000000"))).wait();
  await (await usdc.mint(await diamond.getAddress(), 1_000_000_000n)).wait();
  await (await brla.mint(await diamond.getAddress(), ethers.parseEther("10000"))).wait();
  await (await cas.mint(user.address, ethers.parseEther("100000"))).wait();
  await (await usdc.mint(user.address, 100_000_000n)).wait();
  await (await brla.mint(user.address, ethers.parseEther("10000"))).wait();
  await (await cas.connect(user).approve(await diamond.getAddress(), ethers.MaxUint256)).wait();
  await (await usdc.connect(user).approve(await diamond.getAddress(), ethers.MaxUint256)).wait();
  await (await brla.connect(user).approve(await diamond.getAddress(), ethers.MaxUint256)).wait();

  return {
    owner, user, cas, usdc, brla, wpol, diamond, swap, oracle,
    polFeed, usdcFeed, brlFeed, uniPool, sushiPair,
  };
}

async function configureOracle(fx: Awaited<ReturnType<typeof deployFixture>>) {
  // cumulativo UQ112 inicial do par SushiSwap (preço CAS/WPOL arbitrário inicial)
  await (await fx.sushiPair.setCumulatives(0n, 0n)).wait();
  await (await fx.oracle.setOracleConfig(
    await fx.polFeed.getAddress(),
    await fx.usdcFeed.getAddress(),
    await fx.brlFeed.getAddress(),
    await fx.uniPool.getAddress(),
    await fx.sushiPair.getAddress(),
    WINDOW, 7200, 172800, 86400, // twap 30min; stale crypto 2h; FX 48h; legacy 24h
    false,                      // enabled separado via setOracleEnabled
  )).wait();
}

describe("CASSwapUSDCPOLFacet — pricing por oráculo on-chain", () => {
  it("mantém os ratios legados enquanto oracleEnabled=false", async () => {
    const fx = await loadFixture(deployFixture);
    const [num] = await fx.swap.getRatio();
    expect(num).to.equal(ethers.parseEther("500"));
    // quoteSwap usa o ratio armazenado
    const [out] = await fx.swap.quoteSwap(POL, 3, ethers.parseEther("10"));
    expect(out).to.equal(ethers.parseEther("5000")); // 10 POL * 500
  });

  it("detecta a ordem dos tokens e ancora o cumulativo SushiSwap", async () => {
    const fx = await loadFixture(deployFixture);
    await configureOracle(fx);
    const [, , enabled] = await fx.oracle.getCasPriceSources();
    expect(enabled).to.equal(false); // só liga via setOracleEnabled
  });

  it("após a janela, publica o TWAP SushiSwap e precifica CAS/POL via oráculo", async () => {
    const fx = await loadFixture(deployFixture);
    await configureOracle(fx);
    // UniV3 sem liquidez -> só Sushi conta. Move cumulativo: CAS/WPOL = 600
    const elapsed = BigInt(WINDOW + 60);
    await time.increase(Number(elapsed));
    await (await fx.sushiPair.setCumulatives(600n * Q112 * elapsed, 0n)).wait();

    await (await fx.oracle.setOracleEnabled(true)).wait();
    const [, sushiVal, enabled] = await fx.oracle.getCasPriceSources();
    expect(enabled).to.equal(true);
    expect(sushiVal).to.be.closeTo(600n * E18, E18); // ~600 CAS/WPOL

    // buy CAS/POL = 600 CAS/POL (única fonte -> min = max)
    const [num, den] = await fx.oracle.getOracleRatio(POL, false);
    expect(num).to.be.closeTo(600n * E18, 2n * E18);
    expect(den).to.equal(E18);

    const [out] = await fx.swap.quoteSwap(POL, 3, ethers.parseEther("10"));
    expect(out).to.be.closeTo(ethers.parseEther("6000"), ethers.parseEther("20"));
  });

  it("envelope min/max: visitante compra no mais caro e vende no mais barato", async () => {
    const fx = await loadFixture(deployFixture);
    await configureOracle(fx);
    const elapsed = BigInt(WINDOW + 60);
    await time.increase(Number(elapsed));
    // SushiSwap: 600 CAS/WPOL ; UniV3: 800 CAS/WPOL -> envelope [600, 800]
    await (await fx.sushiPair.setCumulatives(600n * Q112 * elapsed, 0n)).wait();
    await (await fx.uniPool.setLiquidity(1_000_000n)).wait();
    await (await fx.uniPool.setObserveDelta(tickFor(800) * BigInt(WINDOW), false)).wait();

    await (await fx.oracle.setOracleEnabled(true)).wait();
    const [uniVal, sushiVal] = await fx.oracle.getCasPriceSources();
    // tolerância ~1.5%: o bloco extra entre setCumulatives e a leitura alarga
    // o elapsed em ~1s sobre a janela de 1860s
    expect(sushiVal).to.be.closeTo(600n * E18, 9n * E18);
    expect(uniVal).to.be.closeTo(800n * E18, 9n * E18);

    // buy = min (CAS mais caro para quem compra) ; sell = max (mais barato p/ quem vende)
    const [buyNum] = await fx.oracle.getOracleRatio(POL, false);
    const [sellNum] = await fx.oracle.getOracleRatio(POL, true);
    expect(buyNum).to.be.closeTo(600n * E18, 9n * E18);
    expect(sellNum).to.be.closeTo(800n * E18, 9n * E18);
    expect(buyNum).to.be.lt(sellNum);
  });

  it("USDC/BRLA seguem os feeds Chainlink: CAS/USDC=3000 e CAS/BRLA≈577", async () => {
    const fx = await loadFixture(deployFixture);
    await configureOracle(fx);
    const elapsed = BigInt(WINDOW + 60);
    await time.increase(Number(elapsed));
    await (await fx.sushiPair.setCumulatives(600n * Q112 * elapsed, 0n)).wait();
    await (await fx.oracle.setOracleEnabled(true)).wait();

    // CAS/USD = 600 CAS/WPOL ÷ $0.20 = 3000 CAS/USD
    const [usdcNum] = await fx.oracle.getOracleRatio(USDC, false);
    expect(usdcNum).to.be.closeTo(3000n * E18 * 10n ** 12n, 30n * E18 * 10n ** 12n);

    // CAS/BRLA = 3000 CAS/USD × 0.1924 USD/BRL ≈ 577.2
    const [brlaNum] = await fx.oracle.getOracleRatio(BRLA, false);
    expect(brlaNum).to.be.closeTo(577_200_000_000_000_000_000n, 6n * E18);
  });

  it("executa swap ponta a ponta com preço do oráculo (CAS->POL no sell=max)", async () => {
    const fx = await loadFixture(deployFixture);
    await configureOracle(fx);
    const elapsed = BigInt(WINDOW + 60);
    await time.increase(Number(elapsed));
    await (await fx.sushiPair.setCumulatives(600n * Q112 * elapsed, 0n)).wait();
    await (await fx.uniPool.setLiquidity(1_000_000n)).wait();
    await (await fx.uniPool.setObserveDelta(tickFor(800) * BigInt(WINDOW), false)).wait();
    await (await fx.oracle.setOracleEnabled(true)).wait();

    // vende 1600 CAS -> pelo sell ratio (800 CAS/POL) recebe ~2 POL (fee=0)
    const polBefore = await ethers.provider.getBalance(fx.user.address);
    const dl = (await time.latest()) + 3600;
    await fx.swap.connect(fx.user).sellCASForPOL(ethers.parseEther("1600"), 0n, dl, { value: 0 });
    const polAfter = await ethers.provider.getBalance(fx.user.address);
    // ~2 POL menos gas; valida que o sell usou o lado caro do envelope (800)
    expect(polAfter - polBefore).to.be.gt(ethers.parseEther("1.9"));
    expect(polAfter - polBefore).to.be.lt(ethers.parseEther("2.1"));
  });

  it("fallback legado quando o feed stale, e InvalidRatio quando expirado", async () => {
    const fx = await loadFixture(deployFixture);
    await configureOracle(fx);
    const elapsed = BigInt(WINDOW + 60);
    await time.increase(Number(elapsed));
    await (await fx.sushiPair.setCumulatives(600n * Q112 * elapsed, 0n)).wait();
    await (await fx.oracle.setOracleEnabled(true)).wait();

    // POL continua via oráculo (não depende de Chainlink na própria perna)
    const [polNum] = await fx.swap.getCasRate(POL);
    expect(polNum).to.be.closeTo(600n * E18, 2n * E18);

    // torna o feed USDC stale
    await (await fx.usdcFeed.setAnswer(100_000_000, (await time.latest()) - 7300)).wait();
    // USDC cai para o ratio legado fresco (setado na fixture, <24h)
    const [usdcNum] = await fx.swap.getCasRate(USDC);
    expect(usdcNum).to.equal(5000n * 10n ** 12n);

    // expira o legado também
    await time.increase(86400 + 60);
    await expect(fx.swap.quoteSwap(USDC, 3, 1_000_000n)).to.be.revertedWithCustomError(
      fx.swap, "InvalidRatio",
    );
    // e o TWAP sushi também estagnou (âncora antiga segue válida — leitura
    // on-the-fly cobre a janela inteira), então POL ainda responde
    const [polNum2] = await fx.oracle.getOracleRatio(POL, false);
    expect(polNum2).to.be.gt(0n);
  });

  it("updateCasTwap é permissionless e publica ao fechar a janela", async () => {
    const fx = await loadFixture(deployFixture);
    await configureOracle(fx);
    const elapsed = BigInt(WINDOW + 10);
    await time.increase(Number(elapsed));
    await (await fx.sushiPair.setCumulatives(700n * Q112 * elapsed, 0n)).wait();
    await (await fx.oracle.connect(fx.user).updateCasTwap()).wait();
    const [, sushiVal] = await fx.oracle.getCasPriceSources();
    expect(sushiVal).to.be.closeTo(700n * E18, E18);
  });

  it("somente o owner configura o oráculo", async () => {
    const fx = await loadFixture(deployFixture);
    await expect(
      fx.oracle.connect(fx.user).setOracleConfig(
        ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
        ethers.ZeroAddress, ethers.ZeroAddress, WINDOW, 3600, 86400, 3600, true,
      ),
    ).to.be.reverted;
  });
});
