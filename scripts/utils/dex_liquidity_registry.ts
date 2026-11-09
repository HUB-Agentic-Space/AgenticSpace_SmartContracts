/**
 * DEX Liquidity Registry — registro de DEXs suportados para distribuição de liquidez.
 *
 * Cada DEX é configurável via variáveis de ambiente. DEXs do tipo `v2`
 * suportam `addLiquidityETH` (CAS + POL). V3/Algebra/aggregators são
 * registrados para relatório e podem ser estendidos futuramente.
 */

import { ethers } from "ethers";

export type DexType = "v2" | "v3" | "algebra" | "aggregator" | "unsupported";

export interface DexLiquidityConfig {
  name: string;
  type: DexType;
  routerAddress: string | null;
  factoryAddress: string | null;
  lpTokenAddress: string | null;
  quoterAddress: string | null;
  positionManagerAddress: string | null;
  middleToken: string;
  supportsAddLiquidity: boolean;
  notes?: string;
}

const WPOL_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH_ADDRESS = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

function checksum(addr: string | undefined | null): string | null {
  if (!addr) return null;
  try {
    return ethers.getAddress(addr);
  } catch {
    return null;
  }
}

/**
 * Retorna a lista de DEXs configurados.
 * Ordem conforme solicitado: Uniswap V3, APESwap, Sushi Swap, Uniswap V2,
 * KyberSwap, OKX Swap, QuickSwap, Velora, 1inch.
 */
export function buildDexRegistry(): DexLiquidityConfig[] {
  return [
    {
      name: "Uniswap V3",
      type: "v3",
      routerAddress: checksum(process.env.UNISWAP_V3_ROUTER_ADDRESS) ?? checksum(process.env.UNISWAP_V3_ROUTER) ?? "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      factoryAddress: checksum(process.env.UNISWAP_V3_FACTORY_ADDRESS) ?? checksum(process.env.UNISWAP_V3_FACTORY) ?? "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      lpTokenAddress: null,
      quoterAddress: checksum(process.env.UNISWAP_V3_QUOTER_ADDRESS) ?? checksum(process.env.UNISWAP_V3_QUOTER) ?? "0xb27308f9F90D607463bb33eA1BeBb41C2765c608",
      positionManagerAddress: checksum(process.env.UNISWAP_V3_POSITION_MANAGER_ADDRESS) ?? checksum(process.env.UNISWAP_V3_POSITION_MANAGER) ?? "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
      middleToken: WPOL_ADDRESS,
      supportsAddLiquidity: false,
      notes: "V3 requer mint via NonfungiblePositionManager com tick range.",
    },
    {
      name: "ApeSwap",
      type: "v2",
      routerAddress: checksum(process.env.APESWAP_ROUTER_ADDRESS) ?? checksum(process.env.APESWAP_ROUTER) ?? "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
      factoryAddress: checksum(process.env.APESWAP_FACTORY_ADDRESS) ?? checksum(process.env.APESWAP_FACTORY) ?? "0xCf083Be4164828f00cAE704EC15a36D711491284",
      lpTokenAddress: checksum(process.env.APESWAP_LP_TOKEN_ADDRESS) ?? null,
      quoterAddress: null,
      positionManagerAddress: null,
      middleToken: WPOL_ADDRESS,
      supportsAddLiquidity: true,
    },
    {
      name: "SushiSwap",
      type: "v2",
      routerAddress: checksum(process.env.SUSHISWAP_ROUTER_ADDRESS) ?? checksum(process.env.SUSHISWAP_V2_ROUTER) ?? "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
      factoryAddress: checksum(process.env.SUSHISWAP_FACTORY_ADDRESS) ?? checksum(process.env.SUSHISWAP_FACTORY) ?? "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
      lpTokenAddress: checksum(process.env.SUSHISWAP_LP_TOKEN_ADDRESS) ?? null,
      quoterAddress: null,
      positionManagerAddress: null,
      middleToken: WPOL_ADDRESS,
      supportsAddLiquidity: true,
    },
    {
      name: "Uniswap V2",
      type: "v2",
      routerAddress: checksum(process.env.UNISWAP_V2_ROUTER_ADDRESS) ?? checksum(process.env.UNISWAP_V2_ROUTER) ?? null,
      factoryAddress: checksum(process.env.UNISWAP_V2_FACTORY_ADDRESS) ?? checksum(process.env.UNISWAP_V2_FACTORY) ?? null,
      lpTokenAddress: checksum(process.env.UNISWAP_V2_LP_TOKEN_ADDRESS) ?? null,
      quoterAddress: null,
      positionManagerAddress: null,
      middleToken: WPOL_ADDRESS,
      supportsAddLiquidity: true,
      notes: "Uniswap V2 não é nativo na Polygon; configure UNISWAP_V2_ROUTER_ADDRESS para um fork compatível (ex.: QuickSwap V2).",
    },
    {
      name: "KyberSwap",
      type: "aggregator",
      routerAddress: checksum(process.env.KYBERSWAP_ROUTER_ADDRESS) ?? checksum(process.env.KYBERSWAP_DMM_ROUTER) ?? null,
      factoryAddress: checksum(process.env.KYBERSWAP_FACTORY_ADDRESS) ?? checksum(process.env.KYBERSWAP_DMM_FACTORY) ?? null,
      lpTokenAddress: checksum(process.env.KYBERSWAP_LP_TOKEN_ADDRESS) ?? null,
      quoterAddress: null,
      positionManagerAddress: null,
      middleToken: WPOL_ADDRESS,
      supportsAddLiquidity: false,
      notes: "KyberSwap usa DMM/Elastic; roteador e pool devem ser configurados manualmente se houver suporte V2.",
    },
    {
      name: "OKX Swap",
      type: "aggregator",
      routerAddress: checksum(process.env.OKX_SWAP_ROUTER_ADDRESS) ?? null,
      factoryAddress: checksum(process.env.OKX_SWAP_FACTORY_ADDRESS) ?? null,
      lpTokenAddress: checksum(process.env.OKX_SWAP_LP_TOKEN_ADDRESS) ?? null,
      quoterAddress: null,
      positionManagerAddress: null,
      middleToken: WPOL_ADDRESS,
      supportsAddLiquidity: false,
      notes: "OKX Swap é um aggregator; não possui endpoint addLiquidityETH direto.",
    },
    {
      name: "QuickSwap",
      type: "v2",
      routerAddress: checksum(process.env.QUICKSWAP_ROUTER_ADDRESS) ?? checksum(process.env.QUICKSWAP_ROUTER) ?? "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
      factoryAddress: checksum(process.env.QUICKSWAP_FACTORY_ADDRESS) ?? checksum(process.env.QUICKSWAP_FACTORY) ?? "0x5757371414417b8c6caad45baef941abc7d3ab32",
      lpTokenAddress: checksum(process.env.QUICKSWAP_LP_TOKEN_ADDRESS) ?? null,
      quoterAddress: null,
      positionManagerAddress: null,
      middleToken: WPOL_ADDRESS,
      supportsAddLiquidity: true,
    },
    {
      name: "Velora",
      type: "aggregator",
      routerAddress: checksum(process.env.VELORA_ROUTER_ADDRESS) ?? checksum(process.env.VELOPA_ROUTER_ADDRESS) ?? null,
      factoryAddress: checksum(process.env.VELORA_FACTORY_ADDRESS) ?? null,
      lpTokenAddress: checksum(process.env.VELORA_LP_TOKEN_ADDRESS) ?? null,
      quoterAddress: null,
      positionManagerAddress: null,
      middleToken: WPOL_ADDRESS,
      supportsAddLiquidity: false,
      notes: "Velora/Velopa é aggregator; não possui endpoint addLiquidityETH direto.",
    },
    {
      name: "1inch",
      type: "aggregator",
      routerAddress: checksum(process.env.ONEINCH_ROUTER_ADDRESS) ?? null,
      factoryAddress: checksum(process.env.ONEINCH_FACTORY_ADDRESS) ?? null,
      lpTokenAddress: checksum(process.env.ONEINCH_LP_TOKEN_ADDRESS) ?? null,
      quoterAddress: null,
      positionManagerAddress: null,
      middleToken: WPOL_ADDRESS,
      supportsAddLiquidity: false,
      notes: "1inch é um aggregator; use a API de liquidez ou pools específicos se configurados.",
    },
  ];
}

/**
 * Filtra DEXs que suportam addLiquidityETH e possuem router configurado.
 */
export function getSupportedV2Dexes(dexes: DexLiquidityConfig[]): DexLiquidityConfig[] {
  return dexes.filter(
    (d) => d.supportsAddLiquidity && d.routerAddress && d.type === "v2"
  );
}

/**
 * Filtra DEXs que não suportam addLiquidityETH diretamente.
 */
export function getUnsupportedDexes(dexes: DexLiquidityConfig[]): DexLiquidityConfig[] {
  return dexes.filter(
    (d) => !d.supportsAddLiquidity || !d.routerAddress || d.type !== "v2"
  );
}
