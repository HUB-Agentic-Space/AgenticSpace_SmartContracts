import { expect } from "chai";
import {
  buildDexPoolRows,
  buildDexPoolViews,
  isPoolId,
  tokenSymbol,
  uniquePairCount,
  type DexPoolView,
} from "../../scripts/utils/cas_dex_pools";
import type { PoolCreationRecord } from "../../scripts/utils/cas_database";

const CAS = "0x5151a34eac7ba08cd6b540b32cd30316218a2287";
const WPOL = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const PAIR = "0xf77bd26fe17adb1bc9abcdef0123456789abcdef";
const POOLID_V4 = "0x184f2790d70b20af61abcdef0123456789abcdef0123456789abcdef01234567";
const CREATOR = "0x66682bbed9abcdef0123456789abcdef01234567";
const TX = "0xaaaa0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function rec(overrides: Partial<PoolCreationRecord> = {}): PoolCreationRecord {
  return {
    pair_address: PAIR,
    factory_address: "0x5757371414417b8c6caad45baef941abc7d3ab32",
    creator_address: CREATOR,
    token0: WPOL,
    token1: CAS,
    tx_hash: TX,
    block_number: 50_000_000,
    timestamp: 1_700_000_000,
    dex_name: "QuickSwap",
    created_at: "2026-01-01 00:00:00",
    ...overrides,
  };
}

describe("cas_dex_pools — pools DEX on-chain na aba Mercado", () => {
  describe("isPoolId", () => {
    it("detecta bytes32 como PoolId V4", () => {
      expect(isPoolId(POOLID_V4)).to.be.true;
    });
    it("endereço de 40 hex não é PoolId", () => {
      expect(isPoolId(PAIR)).to.be.false;
    });
    it("aceita maiúsculas", () => {
      expect(isPoolId(POOLID_V4.toUpperCase().replace("0X", "0x"))).to.be.true;
    });
  });

  describe("tokenSymbol", () => {
    it("resolve CAS para o token analisado", () => {
      expect(tokenSymbol(CAS, CAS)).to.equal("CAS");
      expect(tokenSymbol(CAS.toUpperCase(), CAS)).to.equal("CAS");
    });
    it("resolve símbolos conhecidos da Polygon", () => {
      expect(tokenSymbol(WPOL, CAS)).to.equal("WPOL");
      expect(tokenSymbol(USDC, CAS)).to.equal("USDC");
    });
    it("usa label quando símbolo não é conhecido", () => {
      const labels = new Map([[PAIR.toLowerCase(), "Meu Token"]]);
      expect(tokenSymbol(PAIR, CAS, labels)).to.equal("Meu Token");
    });
    it("fallback para endereço curto", () => {
      const s = tokenSymbol(PAIR, CAS);
      expect(s).to.match(/^0x.{4}….{4}$/);
    });
  });

  describe("buildDexPoolViews", () => {
    it("monta pairLabel CAS/WPOL e marca V4", () => {
      const views = buildDexPoolViews([
        rec(),
        rec({ pair_address: POOLID_V4, dex_name: "Uniswap V4" }),
      ], CAS);
      expect(views).to.have.length(2);
      const v4 = views.find((v) => v.dexName === "Uniswap V4")!;
      expect(v4.isV4).to.be.true;
      expect(v4.pairLabel).to.equal("WPOL/CAS");
    });
    it("deduplica mesma pair+DEX", () => {
      const views = buildDexPoolViews([rec(), rec()], CAS);
      expect(views).to.have.length(1);
    });
    it("mesma pair em DEXs diferentes não deduplica", () => {
      const views = buildDexPoolViews([
        rec(),
        rec({ dex_name: "SushiSwap" }),
      ], CAS);
      expect(views).to.have.length(2);
    });
    it("ordena do mais recente para o mais antigo", () => {
      const views = buildDexPoolViews([
        rec({ timestamp: 1_600_000_000 }),
        rec({ pair_address: "0x" + "1".repeat(40), timestamp: 1_800_000_000 }),
      ], CAS);
      expect(views[0].timestamp).to.equal(1_800_000_000);
    });
    it("lista vazia retorna array vazio", () => {
      expect(buildDexPoolViews([], CAS)).to.deep.equal([]);
    });
  });

  describe("buildDexPoolRows", () => {
    const views = buildDexPoolViews([
      rec(),
      rec({ pair_address: POOLID_V4, dex_name: "Uniswap V4" }),
    ], CAS);
    const cell = (c: string) => `<b>${c}</b>`;

    it("renderiza uma linha por pool", () => {
      const html = buildDexPoolRows(views, cell);
      expect((html.match(/<tr>/g) ?? [])).to.have.length(2);
    });
    it("linka pool V2 no PolygonScan e PoolId V4 apenas como código", () => {
      const html = buildDexPoolRows(views, cell);
      expect(html).to.contain(`polygonscan.com/address/${PAIR}`);
      expect(html).to.not.contain(`polygonscan.com/address/${POOLID_V4}`);
      expect(html).to.contain('title="PoolId V4 (PoolManager)"');
    });
    it("linka tx de criação e usa callback do criador", () => {
      const html = buildDexPoolRows(views, cell);
      expect(html).to.contain(`polygonscan.com/tx/${TX}`);
      expect(html).to.contain(`<b>${CREATOR}</b>`);
    });
    it("escapa nomes de DEX externos", () => {
      const evil = buildDexPoolViews([rec({ dex_name: '<img onerror="x">' })], CAS);
      const html = buildDexPoolRows(evil, cell);
      expect(html).to.contain("&lt;img");
      expect(html).to.not.contain('<img onerror="x">');
    });
    it("lista vazia renderiza mensagem de fallback em uma linha", () => {
      const html = buildDexPoolRows([], cell);
      expect((html.match(/<tr>/g) ?? [])).to.have.length(1);
      expect(html).to.contain("Nenhum pool on-chain registrado");
    });
    it("permite célula anonimizada do criador", () => {
      const html = buildDexPoolRows(views, () => "<code>Anon 1</code>");
      expect(html).to.contain("Anon 1");
      expect(html).to.not.contain(CREATOR);
    });
  });

  describe("uniquePairCount", () => {
    const pools: DexPoolView[] = buildDexPoolViews([rec()], CAS);
    it("soma pares DexScreener + pools sem duplicar", () => {
      const n = uniquePairCount([{ pairAddress: "0x" + "9".repeat(40) }], pools);
      expect(n).to.equal(2);
    });
    it("deduplica pair presente nas duas fontes (case-insensitive)", () => {
      const n = uniquePairCount([{ pairAddress: PAIR.toUpperCase() }], pools);
      expect(n).to.equal(1);
    });
    it("zero quando ambas fontes vazias", () => {
      expect(uniquePairCount([], [])).to.equal(0);
    });
  });
});
