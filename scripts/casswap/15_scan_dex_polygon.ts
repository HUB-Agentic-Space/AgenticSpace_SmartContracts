import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { SEP, requireEnv } from "../utils/deploy_helpers";

const WPOL_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const ROUTER_ABI = ["function factory() view returns (address)"];
const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)",
];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const DEX_ROUTERS = [
  { name: "QuickSwap", address: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
  { name: "SushiSwap", address: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506" },
  { name: "ApeSwap", address: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" },
  { name: "Dfyn", address: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429" },
];

interface PairData {
  dex: string;
  factory: string;
  pair: string;
  token0: string;
  token1: string;
  isCas0: boolean;
  otherToken: string;
  otherSymbol: string;
  otherDecimals: number;
  casReserve: bigint;
  otherReserve: bigint;
  totalSupply: bigint;
  price: number;
}

function getFortalezaTimestamp(): { dateStr: string; timeStr: string; iso: string } {
  const fortalezaTs = new Date().toLocaleString("sv-SE", { timeZone: "America/Fortaleza" });
  return {
    dateStr: fortalezaTs.slice(0, 10),
    timeStr: fortalezaTs.slice(11, 16).replace(":", "-"),
    iso: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const provider = ethers.provider;
  const { CAS_TOKEN_ADDRESS } = await requireEnv(["CAS_TOKEN_ADDRESS"]);

  const { dateStr, timeStr, iso } = getFortalezaTimestamp();
  const outputFile = `docs/LIQUIDEZ/SCAN_DEX_POLYGON_${dateStr}-${timeStr}.md`;

  console.log(`\n${SEP}`);
  console.log("  Scan de DEXs na Polygon por CAS remanescente");
  console.log(SEP);
  console.log(`  Rede:       Polygon PoS Mainnet`);
  console.log(`  CAS Token:  ${CAS_TOKEN_ADDRESS}`);
  console.log(`  Bloco:      ${await provider.getBlockNumber()}`);
  console.log(`  Timestamp:  ${iso}`);
  console.log(`  Saida:      ${outputFile}\n`);

  const extraRouters = (process.env.EXTRA_DEX_ROUTERS || "")
    .split(",")
    .filter((a) => a !== "" && ethers.isAddress(a))
    .map((address, i) => ({ name: `Extra-${i + 1}`, address }));

  const routers = [...DEX_ROUTERS, ...extraRouters];

  const candidateTokens = [
    { symbol: "WPOL", address: WPOL_ADDRESS },
    { symbol: "USDC", address: process.env.USDC_TOKEN_ADDRESS || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" },
    { symbol: "USDT", address: process.env.USDT_TOKEN_ADDRESS || "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
    { symbol: "DAI", address: process.env.DAI_TOKEN_ADDRESS || "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" },
    { symbol: "WETH", address: process.env.WETH_TOKEN_ADDRESS || "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
    { symbol: "WBTC", address: process.env.WBTC_TOKEN_ADDRESS || "0x1BFD67037B42Cf73acF2047067bd4F2C47D9Bf38" },
  ].filter((t) => t.address !== "" && ethers.isAddress(t.address));

  const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) view returns (address pair)"];

  const pairMap = new Map<string, { dex: string; factory: string }>();

  for (const dex of routers) {
    try {
      const router = new ethers.Contract(dex.address, ROUTER_ABI, provider);
      const factoryAddr = await router.factory();
      const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);

      let foundCount = 0;
      for (const candidate of candidateTokens) {
        try {
          const pairAddr = await factory.getPair(CAS_TOKEN_ADDRESS, candidate.address);
          if (pairAddr && pairAddr !== ethers.ZeroAddress && !pairMap.has(pairAddr)) {
            pairMap.set(pairAddr, { dex: dex.name, factory: factoryAddr });
            foundCount++;
          }
        } catch {
          // ignore candidate
        }
      }

      console.log(`  ${dex.name}: ${foundCount} par(es) encontrado(s)`);
    } catch (err: any) {
      console.log(`  ${dex.name}: erro ao escanear — ${err.message ?? err}`);
    }
  }

  // Garante que os pares conhecidos do .env tambem sejam verificados
  const knownPairEnvs = [
    { name: "QuickSwap", env: "QUICKSWAP_LP_TOKEN_ADDRESS" },
    { name: "SushiSwap", env: "SUSHISWAP_LP_TOKEN_ADDRESS" },
    { name: "ApeSwap", env: "APESWAP_LP_TOKEN_ADDRESS" },
    { name: "Dfyn", env: "DFYN_LP_TOKEN_ADDRESS" },
  ];
  for (const { name, env } of knownPairEnvs) {
    const pairAddr = process.env[env];
    if (pairAddr && ethers.isAddress(pairAddr) && !pairMap.has(pairAddr)) {
      pairMap.set(pairAddr, { dex: name, factory: "" });
    }
  }

  if (pairMap.size === 0) {
    console.log("\n  Nenhum par CAS encontrado nos DEXs escaneados.");
    return;
  }

  console.log(`\n  Total de pares unicos encontrados: ${pairMap.size}`);
  console.log("  Buscando reservas...\n");

  const pairs: PairData[] = [];
  for (const [pairAddr, meta] of pairMap) {
    try {
      const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
      const [token0, token1, [r0, r1], totalSupply] = await Promise.all([
        pair.token0(),
        pair.token1(),
        pair.getReserves(),
        pair.totalSupply(),
      ]);

      const isCas0 = token0.toLowerCase() === CAS_TOKEN_ADDRESS.toLowerCase();
      const casReserve = isCas0 ? BigInt(r0) : BigInt(r1);
      const otherReserve = isCas0 ? BigInt(r1) : BigInt(r0);
      const otherToken = isCas0 ? token1 : token0;

      let otherSymbol = otherToken.toLowerCase() === WPOL_ADDRESS.toLowerCase() ? "WPOL" : "?";
      let otherDecimals = 18;
      if (otherToken.toLowerCase() !== WPOL_ADDRESS.toLowerCase()) {
        try {
          const otherErc20 = new ethers.Contract(otherToken, ERC20_ABI, provider);
          [otherSymbol, otherDecimals] = await Promise.all([otherErc20.symbol(), otherErc20.decimals()]);
        } catch {
          // mantem simbolo padrao
        }
      }

      const casFmt = Number(ethers.formatUnits(casReserve, 18));
      const otherFmt = Number(ethers.formatUnits(otherReserve, otherDecimals));
      const price = otherReserve === 0n ? 0 : casFmt / otherFmt;

      pairs.push({
        dex: meta.dex,
        factory: meta.factory,
        pair: pairAddr,
        token0,
        token1,
        isCas0,
        otherToken,
        otherSymbol,
        otherDecimals,
        casReserve,
        otherReserve,
        totalSupply,
        price,
      });
    } catch (err: any) {
      console.log(`  ERRO lendo par ${pairAddr}: ${err.message ?? err}`);
    }
  }

  pairs.sort((a, b) => (b.casReserve > a.casReserve ? 1 : b.casReserve < a.casReserve ? -1 : 0));
  const totalCas = pairs.reduce((sum, p) => sum + p.casReserve, 0n);

  const rows = pairs
    .map((p) => {
      const otherLabel = p.otherToken.toLowerCase() === WPOL_ADDRESS.toLowerCase() ? "POL" : p.otherSymbol;
      return `| ${p.dex} | ${p.pair} | ${p.otherSymbol} | ${ethers.formatUnits(p.casReserve, 18)} | ${ethers.formatUnits(p.otherReserve, p.otherDecimals)} ${otherLabel} | ${p.price.toFixed(6)} | ${ethers.formatEther(p.totalSupply)} |`;
    })
    .join("\n");

  const blockNumber = Number(await provider.getBlockNumber());
  const rawJson = {
    timestamp: iso,
    network: "Polygon PoS Mainnet",
    chainId: 137,
    blockNumber,
    casToken: CAS_TOKEN_ADDRESS,
    totalCasRemaining: totalCas.toString(),
    totalCasFormatted: ethers.formatUnits(totalCas, 18),
    pairs: pairs.map((p) => ({
      dex: p.dex,
      factory: p.factory,
      pair: p.pair,
      token0: p.token0,
      token1: p.token1,
      isCas0: p.isCas0,
      otherToken: p.otherToken,
      otherSymbol: p.otherSymbol,
      otherDecimals: p.otherDecimals,
      casReserve: p.casReserve.toString(),
      otherReserve: p.otherReserve.toString(),
      totalSupply: p.totalSupply.toString(),
      price: p.price,
    })),
  };

  const md = `---
tags:
  - scan
  - dex
  - liquidity
  - polygon
---

# Scan de DEXs na Polygon — CAS remanescente

> Varredura em busca de liquidez/pares que ainda contenham tokens CAS.

## Metadata

| Campo | Valor |
|---|---|
| Rede | Polygon PoS Mainnet |
| Chain ID | 137 |
| Bloco | ${rawJson.blockNumber} |
| Timestamp | ${iso} |
| CAS Token | ${CAS_TOKEN_ADDRESS} |
| DEXs escaneados | ${routers.map((r) => r.name).join(", ")} |

## Resumo

- **Pares encontrados**: ${pairs.length}
- **CAS remanescente total**: ${ethers.formatUnits(totalCas, 18)} CAS
- **CAS remanescente (wei)**: ${totalCas.toString()}

## Pares encontrados

| DEX | Par LP | Outro token | CAS reserva | Outra reserva | Preço (CAS/outro) | LP total |
|---|---|---|---|---|---|---|
${rows}

## Dados brutos

\`\`\`json
${JSON.stringify(rawJson, (_, v) => typeof v === "bigint" ? v.toString() : v, 2)}
\`\`\`
`;

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, md, "utf8");

  console.log(`\n${SEP}`);
  console.log("  Scan concluido");
  console.log(SEP);
  console.log(`  Pares encontrados: ${pairs.length}`);
  console.log(`  CAS remanescente:  ${ethers.formatUnits(totalCas, 18)} CAS`);
  console.log(`  Arquivo gerado:    ${outputFile}\n`);
}

main().catch((err) => {
  console.error(`\n  Erro fatal: ${err.message ?? err}`);
  process.exit(1);
});
