/**
 * @file binpool_math.ts
 * @notice Funcoes puras de matematica do BinPool (PancakeSwap Infinity).
 * @dev    Extraidas do script 58 para permitir teste unitario sem RPC.
 *         Regras vindas do infinity-core (PriceHelper / BinPoolParametersHelper):
 *
 *           - parameters do PoolKey: binStep (uint16) nos bits [16,32) do
 *             bytes32 (contados do LSB);
 *           - preco do bin = (1 + binStep/10000)^(id - 2^23) em unidades de
 *             token1 (currency1) por token0 (currency0);
 *           - activeId = 2^23 corresponde a preco 1:1;
 *           - num add-liquidity, tokenX (currency0) vai para bins com
 *             binId >= activeId e tokenY (currency1) para bins com
 *             binId <= activeId — o bin ativo recebe os dois.
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

export const REAL_ID_SHIFT = 2 ** 23;
export const ONE_E18 = 10n ** 18n;

/** binStep -> bytes32 parameters: uint16 nos bits [16,32) a partir do LSB. */
export function encodeBinStepParams(binStep: number): string {
  return (
    "0x" + (BigInt(binStep) << 16n).toString(16).padStart(64, "0")
  );
}

/** id do bin a partir do preco Y/X: id = 2^23 + round(ln(p)/ln(1+step/1e4)). */
export function idFromPrice(price: number, binStep: number): number {
  if (!(price > 0) || !(binStep > 0)) {
    throw new Error(`idFromPrice: parametros invalidos (price=${price}, binStep=${binStep})`);
  }
  const base = 1 + binStep / 10_000;
  return Math.round(REAL_ID_SHIFT + Math.log(price) / Math.log(base));
}

/** preco Y/X de um bin: p = (1 + step/1e4)^(id - 2^23). */
export function priceFromId(id: number, binStep: number): number {
  const base = 1 + binStep / 10_000;
  return Math.pow(base, id - REAL_ID_SHIFT);
}

/**
 * Lista de binIds centrada no activeId (mesmo helper dos testes do
 * periphery): numBins impar -> centrado; par -> 1 bin a mais a esquerda.
 */
export function getBinIds(activeId: number, numBins: number): number[] {
  if (numBins < 1) throw new Error("getBinIds: numBins deve ser >= 1");
  const start = activeId - Math.floor(numBins / 2);
  return Array.from({ length: numBins }, (_, i) => start + i);
}

/**
 * Distribuicoes X (currency0, bins >= active) e Y (currency1, bins <= active)
 * com soma EXATA 1e18 — o ultimo bin elegivel absorve o resto da divisao.
 */
export function distributions(binIds: number[], activeId: number): [bigint[], bigint[]] {
  const nbX = binIds.filter((id) => id >= activeId).length;
  const nbY = binIds.filter((id) => id <= activeId).length;
  const baseX = nbX > 0 ? ONE_E18 / BigInt(nbX) : 0n;
  const baseY = nbY > 0 ? ONE_E18 / BigInt(nbY) : 0n;
  let sumX = 0n;
  let sumY = 0n;
  const distX = binIds.map((id) => {
    const v = id >= activeId ? baseX : 0n;
    sumX += v;
    return v;
  });
  const distY = binIds.map((id) => {
    const v = id <= activeId ? baseY : 0n;
    sumY += v;
    return v;
  });
  for (let i = binIds.length - 1; i >= 0; i--) {
    if (distX[i] > 0n) { distX[i] += ONE_E18 - sumX; break; }
  }
  for (let i = binIds.length - 1; i >= 0; i--) {
    if (distY[i] > 0n) { distY[i] += ONE_E18 - sumY; break; }
  }
  return [distX, distY];
}

/** deltaIds = binId - activeId (inteiros relativos, conforme periphery). */
export function deltaIds(binIds: number[], activeId: number): bigint[] {
  return binIds.map((id) => BigInt(id) - BigInt(activeId));
}
