import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { IDiamondCut } from "../../typechain-types";

async function getDeadline(seconds = 3600): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp + seconds);
}

function getSelectors(contract: any): string[] {
  const selectors: string[] = [];
  for (const f of contract.interface.fragments) {
    if ((f as any).type === "function") {
      const sig = (f as any).format("sighash");
      selectors.push(ethers.id(sig).slice(0, 10));
    }
  }
  return selectors;
}

const POL = 0;
const USDC = 1;
const BRLA = 2;
const CAS = 3;

// Ratios humanos usados na fixture:
//   buy:  1 POL = 1000 CAS | 1 USDC = 5000 CAS | 1 BRLA = 800 CAS
//   sell: 1 POL = 1200 CAS | 1 USDC = 6000 CAS | 1 BRLA = 900 CAS
// (sell > buy em CAS/quote => usuário vende CAS por menos quote = spread a favor do swap)
const POL_BUY = ethers.parseEther("1000");
const POL_SELL = ethers.parseEther("1200");
const USDC_BUY = 5000n * 10n ** 12n; // num escalado por 1e12 (USDC 6 dec -> CAS 18 dec)
const USDC_SELL = 6000n * 10n ** 12n;
const BRLA_BUY = ethers.parseEther("800");
const BRLA_SELL = ethers.parseEther("900");
const ONE = ethers.parseEther("1");

describe("CASSwapUSDCPOLFacet — multi-ativo (BRLA + swapExact)", () => {
  async function deployFixture() {
    const [owner, user1] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const casToken = await MockERC20.deploy("CAS Token", "CAS", 18);
    const usdcToken = await MockERC20.deploy("USDC Token", "USDC", 6);
    const brlaToken = await MockERC20.deploy("BRLA Digital", "BRLA", 18);
    await casToken.waitForDeployment();
    await usdcToken.waitForDeployment();
    await brlaToken.waitForDeployment();

    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    const diamondCutFacet = await DiamondCutFacet.deploy();
    await diamondCutFacet.waitForDeployment();

    const Diamond = await ethers.getContractFactory("Diamond");
    const diamond = await Diamond.deploy(owner.address, [{
      facetAddress: await diamondCutFacet.getAddress(),
      action: 0,
      functionSelectors: getSelectors(diamondCutFacet),
    }]);
    await diamond.waitForDeployment();
    const diamondAddr = await diamond.getAddress();

    const SwapFacet = await ethers.getContractFactory("CASSwapUSDCPOLFacet");
    const facet = await SwapFacet.deploy();
    await facet.waitForDeployment();

    const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddr);
    await (await diamondCut.diamondCut([{
      facetAddress: await facet.getAddress(),
      action: 0,
      functionSelectors: getSelectors(facet),
    }], ethers.ZeroAddress, "0x")).wait();

    const swap = await ethers.getContractAt("CASSwapUSDCPOLFacet", diamondAddr);
    await (await swap.initCASSwapUSDCPOL(await casToken.getAddress(), await usdcToken.getAddress())).wait();
    await (await swap.connect(owner).setMaxImpactBps(0n)).wait();
    await (await swap.connect(owner).setBRLAToken(await brlaToken.getAddress())).wait();
    await (await swap.connect(owner).setAllSwapRatiosV2(
      POL_BUY, ONE,
      USDC_BUY, 1n,
      BRLA_BUY, ONE,
      POL_SELL, ONE,
      USDC_SELL, 1n,
      BRLA_SELL, ONE,
    )).wait();

    // Reservas do Diamond
    await casToken.mint(diamondAddr, ethers.parseEther("100000"));
    await usdcToken.mint(diamondAddr, 1_000_000_000000n);
    await brlaToken.mint(diamondAddr, ethers.parseEther("100000"));
    await owner.sendTransaction({ to: diamondAddr, value: ethers.parseEther("1000") });

    // Usuário
    await casToken.mint(user1.address, ethers.parseEther("10000"));
    await usdcToken.mint(user1.address, 100_000_000000n);
    await brlaToken.mint(user1.address, ethers.parseEther("10000"));
    await casToken.connect(user1).approve(diamondAddr, ethers.parseEther("10000"));
    await usdcToken.connect(user1).approve(diamondAddr, 100_000_000000n);
    await brlaToken.connect(user1).approve(diamondAddr, ethers.parseEther("10000"));

    return { owner, user1, casToken, usdcToken, brlaToken, swap, diamondAddr };
  }

  describe("Configuração BRLA", () => {
    it("somente owner pode configurar o token BRLA", async () => {
      const { swap, user1, brlaToken } = await loadFixture(deployFixture);
      await expect(swap.connect(user1).setBRLAToken(await brlaToken.getAddress()))
        .to.be.reverted; // LibDiamond: not contract owner
    });

    it("rejeita endereço zero para BRLA", async () => {
      const { swap, owner } = await loadFixture(deployFixture);
      await expect(swap.connect(owner).setBRLAToken(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(swap, "ZeroAddress");
    });

    it("rejeita ratio BRLA quando o token não está configurado", async () => {
      const [owner] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const casToken = await MockERC20.deploy("CAS", "CAS", 18);
      const usdcToken = await MockERC20.deploy("USDC", "USDC", 6);
      const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
      const dcf = await DiamondCutFacet.deploy();
      const Diamond = await ethers.getContractFactory("Diamond");
      const diamond = await Diamond.deploy(owner.address, [{
        facetAddress: await dcf.getAddress(), action: 0, functionSelectors: getSelectors(dcf),
      }]);
      const SwapFacet = await ethers.getContractFactory("CASSwapUSDCPOLFacet");
      const facet = await SwapFacet.deploy();
      const diamondCut = await ethers.getContractAt("IDiamondCut", await diamond.getAddress());
      await (await diamondCut.diamondCut([{
        facetAddress: await facet.getAddress(), action: 0, functionSelectors: getSelectors(facet),
      }], ethers.ZeroAddress, "0x")).wait();
      const swap = await ethers.getContractAt("CASSwapUSDCPOLFacet", await diamond.getAddress());
      await (await swap.initCASSwapUSDCPOL(await casToken.getAddress(), await usdcToken.getAddress())).wait();
      await expect(swap.setSwapRatioBRLA(800n, 1n))
        .to.be.revertedWithCustomError(swap, "BRLANotConfigured");
    });

    it("rejeita spread inverso nos setters BRLA", async () => {
      const { swap, owner } = await loadFixture(deployFixture);
      await expect(swap.connect(owner).setSwapRatioBRLA(ethers.parseEther("950"), ONE))
        .to.be.revertedWithCustomError(swap, "ReverseSpread").withArgs(BRLA);
      await expect(swap.connect(owner).setSwapRatioBRLASell(ethers.parseEther("700"), ONE))
        .to.be.revertedWithCustomError(swap, "ReverseSpread").withArgs(BRLA);
    });
  });

  describe("Views e escala de decimais", () => {
    it("getCasRate normaliza por decimais (USDC exibe CAS por token inteiro)", async () => {
      const { swap } = await loadFixture(deployFixture);
      const [polN, polD] = await swap.getCasRate(POL);
      expect(polN * ONE / polD / ONE).to.equal(1000n); // 1000 CAS por POL
      const [uN, uD] = await swap.getCasRate(USDC);
      // num = 5000e12, den = 1e12 -> 5000 CAS por USDC (NÃO o mesmo que POL)
      expect(uN / uD).to.equal(5000n);
      const [bN, bD] = await swap.getCasRate(BRLA);
      expect(bN / bD).to.equal(800n);
      const [cN, cD] = await swap.getCasRate(CAS);
      expect(cN).to.equal(1n); expect(cD).to.equal(1n);
    });

    it("quoteSwap(USDC->CAS, 1e6) retorna ~5000 CAS — regressão da escala 1e12", async () => {
      const { swap } = await loadFixture(deployFixture);
      const [out] = await swap.quoteSwap(USDC, CAS, 1_000000n);
      expect(out).to.equal(ethers.parseEther("5000"));
    });

    it("getReservesMulti retorna os quatro saldos", async () => {
      const { swap } = await loadFixture(deployFixture);
      const r = await swap.getReservesMulti();
      expect(r.casBalance).to.equal(ethers.parseEther("100000"));
      expect(r.polBalance).to.equal(ethers.parseEther("1000"));
      expect(r.usdcBalance).to.equal(1_000_000_000000n);
      expect(r.brlaBalance).to.equal(ethers.parseEther("100000"));
    });
  });

  describe("Rotas diretas BRLA <-> CAS", () => {
    it("buyCASWithBRLA: 1 BRLA -> 800 CAS", async () => {
      const { swap, user1, casToken, brlaToken } = await loadFixture(deployFixture);
      const deadline = await getDeadline();
      const balBefore = await casToken.balanceOf(user1.address);
      await expect(swap.connect(user1).buyCASWithBRLA(ONE, 0n, deadline))
        .to.emit(swap, "CASBoughtWithBRLA")
        .withArgs(user1.address, ONE, ethers.parseEther("800"), 0n);
      expect(await casToken.balanceOf(user1.address)).to.equal(balBefore + ethers.parseEther("800"));
      expect(await brlaToken.balanceOf(user1.address)).to.equal(ethers.parseEther("9999"));
    });

    it("sellCASForBRLA: 900 CAS -> 1 BRLA (sell-ratio)", async () => {
      const { swap, user1, brlaToken } = await loadFixture(deployFixture);
      const deadline = await getDeadline();
      const balBefore = await brlaToken.balanceOf(user1.address);
      await expect(swap.connect(user1).sellCASForBRLA(ethers.parseEther("900"), 0n, deadline))
        .to.emit(swap, "CASSoldForBRLA")
        .withArgs(user1.address, ethers.parseEther("900"), ONE, 0n);
      expect(await brlaToken.balanceOf(user1.address)).to.equal(balBefore + ONE);
    });
  });

  describe("Swap genérico — quote == execução em todas as direções", () => {
    it("POL -> CAS e CAS -> POL via swapExact batem com quoteSwap", async () => {
      const { swap, user1, casToken } = await loadFixture(deployFixture);
      const deadline = await getDeadline();
      const [qOut] = await swap.quoteSwap(POL, CAS, ONE);
      expect(qOut).to.equal(ethers.parseEther("1000"));
      const balBefore = await casToken.balanceOf(user1.address);
      await expect(swap.connect(user1).swapExact(POL, CAS, ONE, qOut, deadline, { value: ONE }))
        .to.emit(swap, "SwapExecuted")
        .withArgs(user1.address, POL, CAS, ONE, qOut, 0n);
      expect(await casToken.balanceOf(user1.address)).to.equal(balBefore + qOut);

      const [qPol] = await swap.quoteSwap(CAS, POL, ethers.parseEther("1200"));
      expect(qPol).to.equal(ONE); // 1200 CAS -> 1 POL no sell-ratio
      await swap.connect(user1).swapExact(CAS, POL, ethers.parseEther("1200"), qPol, deadline);
    });

    it("BRLA -> POL compõe buy(BRLA) x sell(POL) sem mover a reserva de CAS", async () => {
      const { swap, user1, casToken, diamondAddr } = await loadFixture(deployFixture);
      const deadline = await getDeadline();
      // 1 BRLA -> 800 CAS-eq -> 800/1200 POL
      const [qOut] = await swap.quoteSwap(BRLA, POL, ONE);
      expect(qOut).to.equal((ONE * 800n) / 1200n);
      const casReserveBefore = await casToken.balanceOf(diamondAddr);
      const polBefore = await ethers.provider.getBalance(user1.address);
      await swap.connect(user1).swapExact(BRLA, POL, ONE, qOut, deadline);
      expect(await casToken.balanceOf(diamondAddr)).to.equal(casReserveBefore); // CAS não se move
      const polAfter = await ethers.provider.getBalance(user1.address);
      expect(polAfter - polBefore).to.be.closeTo(qOut, ethers.parseEther("0.01"));
    });

    it("USDC -> POL e POL -> USDC (ambas as direções do par sem CAS)", async () => {
      const { swap, user1, usdcToken } = await loadFixture(deployFixture);
      const deadline = await getDeadline();
      // 1 USDC -> 5000 CAS-eq -> 5000/1200 POL
      const [qPol] = await swap.quoteSwap(USDC, POL, 1_000000n);
      expect(qPol).to.equal((ONE * 5000n) / 1200n);
      await swap.connect(user1).swapExact(USDC, POL, 1_000000n, qPol, deadline);

      // 1 POL -> 1000 CAS-eq -> 1000/6000 USDC = 166666 base units
      const [qUsdc] = await swap.quoteSwap(POL, USDC, ONE);
      expect(qUsdc).to.equal(166666n);
      const balBefore = await usdcToken.balanceOf(user1.address);
      await swap.connect(user1).swapExact(POL, USDC, ONE, qUsdc, deadline, { value: ONE });
      expect(await usdcToken.balanceOf(user1.address)).to.equal(balBefore + qUsdc);
    });

    it("BRLA -> USDC e USDC -> BRLA", async () => {
      const { swap, user1, usdcToken, brlaToken } = await loadFixture(deployFixture);
      const deadline = await getDeadline();
      // 1 BRLA -> 800 CAS-eq -> 800/6000 USDC
      const [qUsdc] = await swap.quoteSwap(BRLA, USDC, ONE);
      expect(qUsdc).to.equal((ethers.parseEther("800") / (6000n * 10n ** 12n)));
      const usdcBefore = await usdcToken.balanceOf(user1.address);
      await swap.connect(user1).swapExact(BRLA, USDC, ONE, qUsdc, deadline);
      expect(await usdcToken.balanceOf(user1.address)).to.equal(usdcBefore + qUsdc);

      // 1 USDC -> 5000 CAS-eq -> 5000/900 BRLA
      const [qBrla] = await swap.quoteSwap(USDC, BRLA, 1_000000n);
      expect(qBrla).to.equal((5n * 10n ** 21n) / 900n);
      const brlaBefore = await brlaToken.balanceOf(user1.address);
      await swap.connect(user1).swapExact(USDC, BRLA, 1_000000n, qBrla, deadline);
      expect(await brlaToken.balanceOf(user1.address)).to.equal(brlaBefore + qBrla);
    });

    it("fee é cobrada uma única vez sobre o input na rota cruzada", async () => {
      const { swap, owner, user1 } = await loadFixture(deployFixture);
      await (await swap.connect(owner).setSwapFeeBps(100n)).wait(); // 1%
      const deadline = await getDeadline();
      // 1 POL -> fee 0.01 POL -> 990 CAS-eq -> 990/6000 USDC
      const [qOut, qFee] = await swap.quoteSwap(POL, USDC, ONE);
      expect(qFee).to.equal(ONE / 100n);
      expect(qOut).to.equal(((ONE * 99n / 100n) * 1000n) / (6000n * 10n ** 12n));
      await swap.connect(user1).swapExact(POL, USDC, ONE, qOut, deadline, { value: ONE });
    });

    it("reverte em SameTokenSwap, InvalidCurrency, msg.value errado e slippage", async () => {
      const { swap, user1 } = await loadFixture(deployFixture);
      const deadline = await getDeadline();
      await expect(swap.connect(user1).swapExact(POL, POL, ONE, 0n, deadline, { value: ONE }))
        .to.be.revertedWithCustomError(swap, "SameTokenSwap");
      await expect(swap.connect(user1).swapExact(CAS, CAS, ONE, 0n, deadline))
        .to.be.revertedWithCustomError(swap, "SameTokenSwap");
      await expect(swap.connect(user1).swapExact(9, CAS, ONE, 0n, deadline))
        .to.be.revertedWithCustomError(swap, "InvalidCurrency");
      await expect(swap.connect(user1).swapExact(POL, CAS, ONE, 0n, deadline, { value: ONE / 2n }))
        .to.be.revertedWithCustomError(swap, "MsgValueMismatch");
      await expect(swap.connect(user1).swapExact(USDC, CAS, ONE, 0n, deadline, { value: 1n }))
        .to.be.revertedWithCustomError(swap, "MsgValueMismatch");
      const [qOut] = await swap.quoteSwap(BRLA, CAS, ONE);
      await expect(swap.connect(user1).swapExact(BRLA, CAS, ONE, qOut + 1n, deadline))
        .to.be.revertedWithCustomError(swap, "SlippageExceeded");
    });

    it("reverte quando a reserva do token de saída é insuficiente", async () => {
      const { swap, user1 } = await loadFixture(deployFixture);
      const deadline = await getDeadline();
      // Reserva POL = 1000; pedir BRLA->POL com saída > 1000 POL
      const brlaIn = ethers.parseEther("2000"); // 2000 BRLA -> 1.6M CAS-eq -> ~1333 POL
      await expect(swap.connect(user1).swapExact(BRLA, POL, brlaIn, 0n, deadline))
        .to.be.revertedWithCustomError(swap, "InsufficientPOLBalance");
      // Reserva BRLA = 100k; CAS->BRLA precisa de saída > 100k BRLA
      // (a checagem de reserva ocorre antes do pull, então o saldo do
      // usuário não interfere)
      await expect(swap.connect(user1).swapExact(CAS, BRLA, ethers.parseEther("100000000"), 0n, deadline))
        .to.be.revertedWithCustomError(swap, "InsufficientBRLABalance");
    });

    it("respeita prazo (deadline) e pausa", async () => {
      const { swap, user1 } = await loadFixture(deployFixture);
      const past = (await getDeadline()) - 7200n;
      await expect(swap.connect(user1).swapExact(BRLA, CAS, ONE, 0n, past))
        .to.be.revertedWithCustomError(swap, "DeadlineExpired");
    });

    it("venda por sell-ratio sem configurar usa fallback do buy-ratio", async () => {
      const { swap, owner, user1, brlaToken } = await loadFixture(deployFixture);
      // zera o sell BRLA via V2 com sell == buy
      await (await swap.connect(owner).setAllSwapRatiosV2(
        POL_BUY, ONE, USDC_BUY, 1n, BRLA_BUY, ONE,
        POL_SELL, ONE, USDC_SELL, 1n, BRLA_BUY, ONE,
      )).wait();
      const deadline = await getDeadline();
      const balBefore = await brlaToken.balanceOf(user1.address);
      // 800 CAS -> 1 BRLA com sell == buy
      await swap.connect(user1).swapExact(CAS, BRLA, ethers.parseEther("800"), 0n, deadline);
      expect(await brlaToken.balanceOf(user1.address)).to.equal(balBefore + ONE);
    });
  });
});
