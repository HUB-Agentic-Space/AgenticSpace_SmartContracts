/**
 * @file binpool_math.test.ts
 * @notice Testes unitarios das funcoes puras do BinPool (scripts/utils/binpool_math.ts).
 * @dev    Nao usa rede nem RPC — valida o encoding de parameters, a
 *         conversao preco<->binId (PriceHelper do infinity-core), a
 *         geracao de bins centrados e as distribuicoes X/Y com soma 1e18.
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */
import { expect } from "chai";
import {
  REAL_ID_SHIFT,
  ONE_E18,
  encodeBinStepParams,
  idFromPrice,
  priceFromId,
  getBinIds,
  distributions,
  deltaIds,
} from "../../scripts/utils/binpool_math";

describe("binpool_math (PancakeSwap Infinity)", function () {
  describe("encodeBinStepParams", function () {
    it("coloca binStep nos bits [16,32) a partir do LSB", function () {
      // binStep=10 -> 0x000...000a0000
      expect(encodeBinStepParams(10)).to.equal(
        "0x" + (10n << 16n).toString(16).padStart(64, "0"),
      );
      // campo tem exatamente 32 bytes
      expect(encodeBinStepParams(10).length).to.equal(66);
    });

    it("decodifica de volta no offset 16 (layout do BinPoolParametersHelper)", function () {
      const encoded = BigInt(encodeBinStepParams(25));
      const decoded = (encoded >> 16n) & 0xffffn;
      expect(decoded).to.equal(25n);
    });
  });

  describe("idFromPrice / priceFromId", function () {
    it("preco 1:1 corresponde a REAL_ID_SHIFT", function () {
      expect(idFromPrice(1, 10)).to.equal(REAL_ID_SHIFT);
      expect(priceFromId(REAL_ID_SHIFT, 10)).to.equal(1);
    });

    it("round-trip preco -> id -> preco dentro de meio binStep", function () {
      const binStep = 10;
      const target = 6000; // CAS por BNB
      const id = idFromPrice(target, binStep);
      const back = priceFromId(id, binStep);
      // erro < metade de um binStep (0.05% para step=10)
      expect(Math.abs(back / target - 1)).to.be.lessThan(binStep / 20_000);
    });

    it("id cresce com o preco (monotonia)", function () {
      const s = 25;
      expect(idFromPrice(2, s)).to.be.greaterThan(idFromPrice(1, s));
      expect(idFromPrice(1, s)).to.be.greaterThan(idFromPrice(0.5, s));
    });

    it("rejeita preco ou step invalidos", function () {
      expect(() => idFromPrice(0, 10)).to.throw();
      expect(() => idFromPrice(-1, 10)).to.throw();
      expect(() => idFromPrice(1, 0)).to.throw();
    });
  });

  describe("getBinIds", function () {
    it("numBins impar centra no activeId", function () {
      expect(getBinIds(100, 3)).to.deep.equal([99, 100, 101]);
      expect(getBinIds(100, 5)).to.deep.equal([98, 99, 100, 101, 102]);
    });

    it("numBins par adiciona 1 bin a esquerda (mesma regra do helper)", function () {
      expect(getBinIds(100, 4)).to.deep.equal([98, 99, 100, 101]);
    });

    it("rejeita numBins < 1", function () {
      expect(() => getBinIds(100, 0)).to.throw();
    });
  });

  describe("distributions", function () {
    it("soma exata de 1e18 em X e Y", function () {
      const ids = getBinIds(100, 5);
      const [dx, dy] = distributions(ids, 100);
      expect(dx.reduce((a, b) => a + b, 0n)).to.equal(ONE_E18);
      expect(dy.reduce((a, b) => a + b, 0n)).to.equal(ONE_E18);
    });

    it("X vai para bins >= active, Y para bins <= active (sobrepostos no ativo)", function () {
      const ids = getBinIds(100, 5); // [98..102]
      const [dx, dy] = distributions(ids, 100);
      // X: bins 100,101,102 -> zero nos dois primeiros
      expect(dx[0]).to.equal(0n);
      expect(dx[1]).to.equal(0n);
      expect(dx[2]).to.be.greaterThan(0n);
      expect(dx[4]).to.be.greaterThan(0n);
      // Y: bins 98,99,100 -> zero nos dois ultimos
      expect(dy[0]).to.be.greaterThan(0n);
      expect(dy[2]).to.be.greaterThan(0n);
      expect(dy[3]).to.equal(0n);
      expect(dy[4]).to.equal(0n);
      // bin ativo recebe ambos
      expect(dx[2]).to.be.greaterThan(0n);
      expect(dy[2]).to.be.greaterThan(0n);
    });

    it("soma exata tambem com divisao nao-exata (numBins=4)", function () {
      const ids = getBinIds(100, 4); // [98,99,100,101]
      const [dx, dy] = distributions(ids, 100);
      expect(dx.reduce((a, b) => a + b, 0n)).to.equal(ONE_E18);
      expect(dy.reduce((a, b) => a + b, 0n)).to.equal(ONE_E18);
    });
  });

  describe("deltaIds", function () {
    it("retorna deslocamentos relativos ao activeId", function () {
      expect(deltaIds([98, 99, 100, 101, 102], 100)).to.deep.equal([-2n, -1n, 0n, 1n, 2n]);
    });
  });
});
