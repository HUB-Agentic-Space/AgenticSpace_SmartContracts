import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { ethers } from "hardhat";
import { SEP, requireEnv, sendAndVerify } from "../utils/deploy_helpers";
import { polyScanLink } from "../utils/vis_tooltip";

const WPOL_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function removeLiquidityETH(address token, uint liquidity, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external returns (uint amountToken, uint amountETH)",
  "function removeLiquidity(address tokenA, address tokenB, uint liquidity, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB)",
];

const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) view returns (address pair)"];

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const LOCK_ABI = [
  "function lpToken() view returns (address)",
  "function getLPTokenBalance() view returns (uint256)",
  "function isExpired() view returns (bool)",
  "function owner() view returns (address)",
  "function withdraw()",
];

const V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
];

const V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function liquidity() view returns (uint128)",
];

const V3_POSITION_MANAGER_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address, uint256) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthGlobal0X128, uint256 feeGrowthGlobal1X128, int128 tokensOwed0, int128 tokensOwed1)",
  "function decreaseLiquidity(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) external returns (uint256 amount0, uint256 amount1)",
  "function collect(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) external payable returns (uint256 amount0, uint256 amount1)",
];

const DEX_ROUTERS = [
  { name: "QuickSwap", address: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
  { name: "SushiSwap", address: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506" },
  { name: "ApeSwap", address: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" },
  { name: "Dfyn", address: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429" },
];

interface PairToDrain {
  dex: string;
  router: string;
  pair: string;
  otherToken: string;
  otherSymbol: string;
  otherDecimals: number;
  isWpol: boolean;
  deployerLp: bigint;
  lockLp: bigint;
  casReserve: bigint;
  otherReserve: bigint;
  totalSupply: bigint;
}

interface V3Position {
  tokenId: string;
  token0: string;
  token1: string;
  fee: number;
  liquidity: bigint;
  otherToken: string;
  otherSymbol: string;
  otherDecimals: number;
  isCas0: boolean;
  poolAddr: string;
}

interface V3PoolFound {
  addr: string;
  fee: number;
  otherSymbol: string;
  liquidity: bigint;
}

function getFortalezaTimestamp(): { dateStr: string; timeStr: string; iso: string } {
  const fortalezaTs = new Date().toLocaleString("sv-SE", { timeZone: "America/Fortaleza" });
  return {
    dateStr: fortalezaTs.slice(0, 10),
    timeStr: fortalezaTs.slice(11, 16).replace(":", "-"),
    iso: new Date().toISOString(),
  };
}

async function getTxOptions(provider: any) {
  const feeData = await provider.getFeeData();
  const latestBlock = await provider.getBlock("latest");
  const baseFee = latestBlock?.baseFeePerGas ?? 0n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? 25_000_000_000n;
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const { CAS_TOKEN_ADDRESS, LP_LOCK_ADDRESS } = await requireEnv(["CAS_TOKEN_ADDRESS", "LP_LOCK_ADDRESS"]);

  const { dateStr, timeStr, iso } = getFortalezaTimestamp();
  const outputFile = `docs/LIQUIDEZ/DRAIN_DEX_POLYGON_${dateStr}-${timeStr}.md`;

  console.log(`\n${SEP}`);
  console.log("  Drenagem de liquidez dos DEXs (remove LP e zera reservas)");
  console.log(SEP);
  console.log(`  Rede:       Polygon PoS Mainnet`);
  console.log(`  CAS Token:  ${CAS_TOKEN_ADDRESS}`);
  console.log(`  Lock:       ${LP_LOCK_ADDRESS}`);
  console.log(`  Deployer:   ${deployer.address}`);
  console.log(`  Bloco:      ${await provider.getBlockNumber()}`);
  console.log(`  Timestamp:  ${iso}`);
  console.log(`  Saida:      ${outputFile}\n`);

  const candidateTokens = [
    { symbol: "WPOL", address: WPOL_ADDRESS },
    { symbol: "USDC", address: process.env.USDC_TOKEN_ADDRESS || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" },
    { symbol: "USDT", address: process.env.USDT_TOKEN_ADDRESS || "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
    { symbol: "DAI", address: process.env.DAI_TOKEN_ADDRESS || "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" },
    { symbol: "WETH", address: process.env.WETH_TOKEN_ADDRESS || "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
    { symbol: "WBTC", address: process.env.WBTC_TOKEN_ADDRESS || "0x1BFD67037B42Cf73acF2047067bd4F2C47D9Bf38" },
  ].filter((t) => t.address !== "" && ethers.isAddress(t.address));

  const extraRouters = (process.env.EXTRA_DEX_ROUTERS || "")
    .split(",")
    .filter((a) => a !== "" && ethers.isAddress(a))
    .map((address, i) => ({ name: `Extra-${i + 1}`, address }));

  const routers = [...DEX_ROUTERS, ...extraRouters];

  const pairMap = new Map<string, PairToDrain>();

  for (const dex of routers) {
    try {
      const router = new ethers.Contract(dex.address, ROUTER_ABI, deployer);
      const factoryAddr = await router.factory();
      const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);

      for (const candidate of candidateTokens) {
        try {
          const pairAddr = await factory.getPair(CAS_TOKEN_ADDRESS, candidate.address);
          if (!pairAddr || pairAddr === ethers.ZeroAddress) continue;

          const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
          const [token0, token1, [r0, r1], totalSupply, deployerLp, lockLp] = await Promise.all([
            pair.token0(),
            pair.token1(),
            pair.getReserves(),
            pair.totalSupply(),
            pair.balanceOf(deployer.address),
            pair.balanceOf(LP_LOCK_ADDRESS),
          ]);

          const isCas0 = token0.toLowerCase() === CAS_TOKEN_ADDRESS.toLowerCase();
          const otherToken = isCas0 ? token1 : token0;
          let otherSymbol = otherToken.toLowerCase() === WPOL_ADDRESS.toLowerCase() ? "WPOL" : "?";
          let otherDecimals = 18;
          if (otherToken.toLowerCase() !== WPOL_ADDRESS.toLowerCase()) {
            try {
              const otherErc20 = new ethers.Contract(otherToken, ERC20_ABI, provider);
              [otherSymbol, otherDecimals] = await Promise.all([otherErc20.symbol(), otherErc20.decimals()]);
            } catch {
              // ignore
            }
          }

          const isWpol = otherToken.toLowerCase() === WPOL_ADDRESS.toLowerCase();
          const casReserve = isCas0 ? BigInt(r0) : BigInt(r1);
          const otherReserve = isCas0 ? BigInt(r1) : BigInt(r0);

          pairMap.set(pairAddr, {
            dex: dex.name,
            router: dex.address,
            pair: pairAddr,
            otherToken,
            otherSymbol,
            otherDecimals,
            isWpol,
            deployerLp: BigInt(deployerLp),
            lockLp: BigInt(lockLp),
            casReserve: BigInt(casReserve),
            otherReserve: BigInt(otherReserve),
            totalSupply: BigInt(totalSupply),
          });
        } catch {
          // ignore candidate
        }
      }
    } catch (err: any) {
      console.log(`  ${dex.name}: erro ao identificar pares — ${err.message ?? err}`);
    }
  }

  // Adiciona pares explicitos do .env como fallback
  const envPairs = [
    { name: "QuickSwap", env: "QUICKSWAP_LP_TOKEN_ADDRESS" },
    { name: "SushiSwap", env: "SUSHISWAP_LP_TOKEN_ADDRESS" },
    { name: "ApeSwap", env: "APESWAP_LP_TOKEN_ADDRESS" },
    { name: "Dfyn", env: "DFYN_LP_TOKEN_ADDRESS" },
  ];
  for (const { name, env } of envPairs) {
    const pairAddr = process.env[env];
    if (!pairAddr || !ethers.isAddress(pairAddr) || pairMap.has(pairAddr)) continue;
    try {
      const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
      const [token0, token1, [r0, r1], totalSupply, deployerLp, lockLp] = await Promise.all([
        pair.token0(),
        pair.token1(),
        pair.getReserves(),
        pair.totalSupply(),
        pair.balanceOf(deployer.address),
        pair.balanceOf(LP_LOCK_ADDRESS),
      ]);
      const isCas0 = token0.toLowerCase() === CAS_TOKEN_ADDRESS.toLowerCase();
      const otherToken = isCas0 ? token1 : token0;
      let otherSymbol = otherToken.toLowerCase() === WPOL_ADDRESS.toLowerCase() ? "WPOL" : "?";
      let otherDecimals = 18;
      if (otherToken.toLowerCase() !== WPOL_ADDRESS.toLowerCase()) {
        try {
          const otherErc20 = new ethers.Contract(otherToken, ERC20_ABI, provider);
          [otherSymbol, otherDecimals] = await Promise.all([otherErc20.symbol(), otherErc20.decimals()]);
        } catch {
          // ignore
        }
      }
      const isWpol = otherToken.toLowerCase() === WPOL_ADDRESS.toLowerCase();
      pairMap.set(pairAddr, {
        dex: name,
        router: "",
        pair: pairAddr,
        otherToken,
        otherSymbol,
        otherDecimals,
        isWpol,
        deployerLp: BigInt(deployerLp),
        lockLp: BigInt(lockLp),
        casReserve: BigInt(isCas0 ? r0 : r1),
        otherReserve: BigInt(isCas0 ? r1 : r0),
        totalSupply: BigInt(totalSupply),
      });
    } catch {
      // ignore
    }
  }

  if (pairMap.size === 0) {
    console.log("\n  Nenhum par CAS encontrado.");
    return;
  }

  const txOptions = await getTxOptions(provider);
  const displayGasPrice = txOptions.maxFeePerGas;
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const lock = new ethers.Contract(LP_LOCK_ADDRESS, LOCK_ABI, deployer);
  let lockLpToken = "";
  try {
    lockLpToken = await lock.lpToken();
  } catch {
    // contrato pode nao ter lpToken (MultiToken)
  }

  const results: string[] = [];
  const withdrawnFromLock: string[] = [];
  const drained: PairToDrain[] = [];
  const skipped: PairToDrain[] = [];

  for (const p of pairMap.values()) {
    console.log(`\n  ${p.dex} — ${p.pair}`);
    console.log(`    Reserva CAS:  ${ethers.formatUnits(p.casReserve, 18)}`);
    console.log(`    LP deployer:  ${ethers.formatEther(p.deployerLp)}`);
    console.log(`    LP lock:      ${ethers.formatEther(p.lockLp)}`);

    let currentDeployerLp = p.deployerLp;

    // Tenta resgatar LP do lock, se for o mesmo LP e ja expirou
    if (p.lockLp > 0n && lockLpToken.toLowerCase() === p.pair.toLowerCase()) {
      try {
        const expired = await lock.isExpired();
        const owner = await lock.owner();
        if (expired && owner.toLowerCase() === deployer.address.toLowerCase()) {
          await sendAndVerify(`${p.dex} lock withdraw`, lock.withdraw(txOptions), displayGasPrice);
          currentDeployerLp += p.lockLp;
          withdrawnFromLock.push(p.pair);
          console.log(`    Resgatado ${ethers.formatEther(p.lockLp)} LP do lock para deployer.`);
        } else {
          console.log(`    Lock nao expirado ou deployer nao e owner. Nao e possivel resgatar.`);
        }
      } catch (err: any) {
        console.log(`    Erro ao resgatar do lock: ${err.message ?? err}`);
      }
    } else if (p.lockLp > 0n) {
      console.log(`    Lock contem LP, mas o lock e para outro token (${lockLpToken}). Nao e possivel resgatar.`);
    }

    if (currentDeployerLp === 0n) {
      console.log(`    Nenhum LP disponivel para drenar. Trade permanece ativo.`);
      skipped.push(p);
      results.push(`| ${p.dex} | ${p.pair} | ${ethers.formatUnits(p.casReserve, 18)} | ${ethers.formatUnits(p.otherReserve, p.otherDecimals)} ${p.otherSymbol} | NENHUM LP |`);
      continue;
    }

    try {
      const pair = new ethers.Contract(p.pair, PAIR_ABI, deployer);
      const router = new ethers.Contract(p.router, ROUTER_ABI, deployer);

      await sendAndVerify(
        `${p.dex} approve LP para router`,
        pair.approve(p.router, currentDeployerLp, txOptions),
        displayGasPrice,
      );

      if (p.isWpol) {
        await sendAndVerify(
          `${p.dex} removeLiquidityETH(${ethers.formatEther(currentDeployerLp)} LP)`,
          router.removeLiquidityETH(
            CAS_TOKEN_ADDRESS,
            currentDeployerLp,
            0,
            0,
            deployer.address,
            deadline,
            txOptions,
          ),
          displayGasPrice,
        );
      } else {
        await sendAndVerify(
          `${p.dex} removeLiquidity(${ethers.formatEther(currentDeployerLp)} LP)`,
          router.removeLiquidity(
            CAS_TOKEN_ADDRESS,
            p.otherToken,
            currentDeployerLp,
            0,
            0,
            deployer.address,
            deadline,
            txOptions,
          ),
          displayGasPrice,
        );
      }

      drained.push(p);
      results.push(`| ${p.dex} | ${p.pair} | ${ethers.formatUnits(p.casReserve, 18)} | ${ethers.formatUnits(p.otherReserve, p.otherDecimals)} ${p.otherSymbol} | REMOVIDO |`);
      console.log(`    Liquidez drenada com sucesso.`);
    } catch (err: any) {
      skipped.push(p);
      results.push(`| ${p.dex} | ${p.pair} | ${ethers.formatUnits(p.casReserve, 18)} | ${ethers.formatUnits(p.otherReserve, p.otherDecimals)} ${p.otherSymbol} | ERRO: ${err.message ?? err} |`);
      console.log(`    ERRO ao drenar: ${err.message ?? err}`);
    }
  }

  // === Uniswap V3 ===
  console.log(`\n  --- Uniswap V3 ---`);

  const v3FactoryAddr = process.env.UNISWAP_V3_FACTORY || "0x1F98431c8aD98503651564eAcA7244605C59aB88";
  const v3PosManagerAddr = process.env.UNISWAP_V3_POSITION_MANAGER || "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
  const v3FeeTiers = [500, 3000, 10000];

  const v3Factory = new ethers.Contract(v3FactoryAddr, V3_FACTORY_ABI, provider);
  const v3PoolsFound: V3PoolFound[] = [];

  for (const candidate of candidateTokens) {
    for (const fee of v3FeeTiers) {
      try {
        const poolAddr = await v3Factory.getPool(CAS_TOKEN_ADDRESS, candidate.address, fee);
        if (!poolAddr || poolAddr === ethers.ZeroAddress) continue;
        const pool = new ethers.Contract(poolAddr, V3_POOL_ABI, provider);
        const liquidity = await pool.liquidity();
        v3PoolsFound.push({ addr: poolAddr, fee, otherSymbol: candidate.symbol, liquidity });
        console.log(`    Pool V3: ${poolAddr} (fee ${fee}, ${candidate.symbol}, liq ${liquidity})`);
      } catch { /* ignore */ }
    }
  }

  const v3PosManager = new ethers.Contract(v3PosManagerAddr, V3_POSITION_MANAGER_ABI, deployer);
  const v3Balance = await v3PosManager.balanceOf(deployer.address);
  console.log(`    Deployer possui ${v3Balance} posição(ões) V3`);

  const v3Positions: V3Position[] = [];
  for (let i = 0n; i < v3Balance; i++) {
    try {
      const tokenId = await v3PosManager.tokenOfOwnerByIndex(deployer.address, i);
      const pos = await v3PosManager.positions(tokenId);
      const isCas0 = pos.token0.toLowerCase() === CAS_TOKEN_ADDRESS.toLowerCase();
      const isCas1 = pos.token1.toLowerCase() === CAS_TOKEN_ADDRESS.toLowerCase();
      if (!isCas0 && !isCas1) continue;

      const otherToken = isCas0 ? pos.token1 : pos.token0;
      let otherSymbol = "?";
      let otherDecimals = 18;
      try {
        const otherErc20 = new ethers.Contract(otherToken, ERC20_ABI, provider);
        [otherSymbol, otherDecimals] = await Promise.all([otherErc20.symbol(), otherErc20.decimals()]);
      } catch { /* ignore */ }

      let poolAddr = "";
      try { poolAddr = await v3Factory.getPool(pos.token0, pos.token1, pos.fee); } catch { /* ignore */ }

      v3Positions.push({
        tokenId: tokenId.toString(),
        token0: pos.token0,
        token1: pos.token1,
        fee: Number(pos.fee),
        liquidity: pos.liquidity,
        otherToken, otherSymbol, otherDecimals, isCas0, poolAddr,
      });
      console.log(`    Posição V3 #${tokenId}: fee ${pos.fee}, liq ${pos.liquidity}, ${otherSymbol}`);
    } catch (err: any) {
      console.log(`    Erro ao ler posição V3 #${i}: ${err.message ?? err}`);
    }
  }

  const v3Results: string[] = [];
  const v3Drained: V3Position[] = [];
  const v3Skipped: V3Position[] = [];

  for (const pos of v3Positions) {
    if (pos.liquidity === 0n) {
      console.log(`    V3 #${pos.tokenId}: liquidez zero — pulando.`);
      v3Skipped.push(pos);
      v3Results.push(`| V3 #${pos.tokenId} | ${pos.poolAddr} | ${pos.fee} | ${pos.otherSymbol} | 0 | NENHUMA LIQUIDEZ |`);
      continue;
    }
    try {
      console.log(`    V3 #${pos.tokenId}: drenando ${pos.liquidity} liquidez...`);
      await sendAndVerify(
        `V3 decreaseLiquidity(#${pos.tokenId})`,
        v3PosManager.decreaseLiquidity(pos.tokenId, pos.liquidity, 0, 0, deadline, txOptions),
        displayGasPrice,
      );
      await sendAndVerify(
        `V3 collect(#${pos.tokenId})`,
        v3PosManager.collect(pos.tokenId, deployer.address, ethers.MaxUint128, ethers.MaxUint128, txOptions),
        displayGasPrice,
      );
      v3Drained.push(pos);
      v3Results.push(`| V3 #${pos.tokenId} | ${pos.poolAddr} | ${pos.fee} | ${pos.otherSymbol} | ${pos.liquidity} | REMOVIDO |`);
      console.log(`    V3 #${pos.tokenId}: drenada com sucesso.`);
    } catch (err: any) {
      v3Skipped.push(pos);
      v3Results.push(`| V3 #${pos.tokenId} | ${pos.poolAddr} | ${pos.fee} | ${pos.otherSymbol} | ${pos.liquidity} | ERRO: ${err.message ?? err} |`);
      console.log(`    V3 #${pos.tokenId}: ERRO: ${err.message ?? err}`);
    }
  }

  const totalCasRemoved = drained.reduce((sum, p) => sum + p.casReserve, 0n);
  const totalCasSkipped = skipped.reduce((sum, p) => sum + p.casReserve, 0n);

  const md = `---
tags:
  - drain
  - dex
  - liquidity
  - polygon
---

# Drenagem de liquidez dos DEXs na Polygon

> Remove liquidez real das pools (burn LP) para suspender o trade.

## Metadata

| Campo | Valor |
|---|---|
| Rede | Polygon PoS Mainnet |
| Chain ID | 137 |
| Bloco | ${await provider.getBlockNumber()} |
| Timestamp | ${iso} |
| CAS Token | ${CAS_TOKEN_ADDRESS} |
| Lock | ${LP_LOCK_ADDRESS} |
| Deployer | ${deployer.address} |

## Resumo V2

- **Pares V2 verificados**: ${pairMap.size}
- **V2 Drenados**: ${drained.length}
- **V2 Nao drenados (sem LP)**: ${skipped.length}
- **CAS removido das pools V2**: ${ethers.formatUnits(totalCasRemoved, 18)} CAS
- **CAS ainda ativo em pools V2 nao drenadas**: ${ethers.formatUnits(totalCasSkipped, 18)} CAS
- **Resgatado do lock**: ${withdrawnFromLock.join(", ") || "nenhum"}

## Resumo V3

- **Pools V3 encontradas**: ${v3PoolsFound.length}
- **Posições V3 do deployer**: ${v3Positions.length}
- **V3 Drenadas**: ${v3Drained.length}
- **V3 Nao drenadas**: ${v3Skipped.length}

## Detalhes V2 por par

| DEX | Par LP | CAS reserva | Outra reserva | Status |
|---|---|---|---|---|
${results.join("\n")}

## Detalhes V3 por posição

| Posição | Pool | Fee | Outro token | Liquidez | Status |
|---|---|---|---|---|---|
${v3Results.length > 0 ? v3Results.join("\n") : "| — | — | — | — | — | Nenhuma posição V3 |"}

## Pools V3 encontradas

| Pool | Fee | Outro token | Liquidez |
|---|---|---|---|
${v3PoolsFound.length > 0 ? v3PoolsFound.map(p => `| ${p.addr} | ${p.fee} | ${p.otherSymbol} | ${p.liquidity} |`).join("\n") : "| — | — | — | Nenhuma pool V3 |"}
`;

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, md, "utf8");

  const blockNumber = await provider.getBlockNumber();
  const outputHtml = outputFile.replace(/\.md$/, ".html");
  const html = buildDrainHtml({
    iso, blockNumber, casToken: CAS_TOKEN_ADDRESS, lock: LP_LOCK_ADDRESS,
    deployer: deployer.address, v3Factory: v3FactoryAddr, v3PosManager: v3PosManagerAddr,
  }, drained, skipped, results, v3Drained, v3Skipped, v3Results, v3PoolsFound,
    totalCasRemoved, totalCasSkipped, withdrawnFromLock);
  fs.writeFileSync(outputHtml, html, "utf8");

  console.log(`\n${SEP}`);
  console.log("  Drenagem concluida");
  console.log(SEP);
  console.log(`  V2 Drenados:       ${drained.length}`);
  console.log(`  V2 Pendentes:      ${skipped.length}`);
  console.log(`  V3 Drenadas:       ${v3Drained.length}`);
  console.log(`  V3 Pendentes:      ${v3Skipped.length}`);
  console.log(`  CAS removido V2:   ${ethers.formatUnits(totalCasRemoved, 18)} CAS`);
  console.log(`  CAS ativo V2:      ${ethers.formatUnits(totalCasSkipped, 18)} CAS`);
  console.log(`  MD:                ${outputFile}`);
  console.log(`  HTML:              ${outputHtml}`);
  console.log(`  Abrindo navegador...\n`);

  openBrowser(path.resolve(outputHtml));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function openBrowser(filePath: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(opener, [filePath], (err) => {
    if (err) {
      console.log(`  Aviso: nao foi possivel abrir o navegador automaticamente.`);
      console.log(`  Abra manualmente: ${filePath}`);
    } else {
      console.log(`  HTML aberto no navegador: ${filePath}`);
    }
  });
}

interface DrainHtmlMeta {
  iso: string;
  blockNumber: number;
  casToken: string;
  lock: string;
  deployer: string;
  v3Factory: string;
  v3PosManager: string;
}

function buildDrainHtml(
  meta: DrainHtmlMeta,
  drained: PairToDrain[],
  skipped: PairToDrain[],
  results: string[],
  v3Drained: V3Position[],
  v3Skipped: V3Position[],
  v3Results: string[],
  v3PoolsFound: V3PoolFound[],
  totalCasRemoved: bigint,
  totalCasSkipped: bigint,
  withdrawnFromLock: string[],
): string {
  const v2Rows = results.map(r => {
    const cells = r.split("|").map(c => c.trim()).filter(c => c !== "");
    if (cells.length < 5) return "";
    const status = cells[4];
    const statusClass = status.startsWith("REMOVIDO") ? "badge-ok" : status.startsWith("ERRO") ? "badge-err" : "badge-warn";
    return `<tr><td><b>${escapeHtml(cells[0])}</b></td><td>${polyScanLink(cells[1], cells[1])}</td><td class="num">${escapeHtml(cells[2])}</td><td class="num">${escapeHtml(cells[3])}</td><td><span class="badge ${statusClass}">${escapeHtml(status)}</span></td></tr>`;
  }).filter(r => r !== "").join("\n");

  const v3Rows = v3Results.map(r => {
    const cells = r.split("|").map(c => c.trim()).filter(c => c !== "");
    if (cells.length < 6) return "";
    const status = cells[5];
    const statusClass = status.startsWith("REMOVIDO") ? "badge-ok" : status.startsWith("ERRO") ? "badge-err" : "badge-warn";
    return `<tr><td><b>${escapeHtml(cells[0])}</b></td><td>${polyScanLink(cells[1], cells[1])}</td><td class="num">${escapeHtml(cells[2])}</td><td>${escapeHtml(cells[3])}</td><td class="num">${escapeHtml(cells[4])}</td><td><span class="badge ${statusClass}">${escapeHtml(status)}</span></td></tr>`;
  }).filter(r => r !== "").join("\n");

  const poolRows = v3PoolsFound.map(p =>
    `<tr><td>${polyScanLink(p.addr, p.addr)}</td><td class="num">${p.fee}</td><td>${escapeHtml(p.otherSymbol)}</td><td class="num">${p.liquidity}</td></tr>`
  ).join("\n");

  const kpis = [
    { label: "V2 Drenados", value: drained.length, color: "var(--color-primary)" },
    { label: "V2 Pendentes", value: skipped.length, color: "var(--color-accent-gold)" },
    { label: "V3 Drenadas", value: v3Drained.length, color: "var(--color-primary)" },
    { label: "V3 Pendentes", value: v3Skipped.length, color: "var(--color-accent-gold)" },
    { label: "Pools V3", value: v3PoolsFound.length, color: "var(--color-accent-bronze)" },
    { label: "CAS Removido V2", value: ethers.formatUnits(totalCasRemoved, 18), color: "var(--color-accent-coral)" },
  ];

  const kpiHtml = kpis.map(k =>
    `<div class="kpi"><div class="kpi-val" style="color:${k.color};">${k.value}</div><div class="kpi-label">${k.label}</div></div>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Drenagem de Liquidez — ${meta.iso}</title>
<style>
  :root {
    --color-primary: #F05F40;
    --color-primary-hover: #eb3812;
    --color-dark: #222222;
    --color-light: #ffffff;
    --color-accent-gold: #fcc650;
    --color-accent-bronze: #cc7501;
    --color-accent-wine: #712d23;
    --color-accent-coral: #ce6e6d;
    --color-accent-peach: #f7d4ca;
    --color-accent-deep-black: #070404;
    --color-bg-main: var(--color-dark);
    --color-bg-card: var(--color-accent-wine);
    --color-text-main: var(--color-light);
    --color-text-muted: var(--color-accent-peach);
    --color-border: rgba(255, 255, 255, 0.15);
    --color-link: var(--color-accent-gold);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--color-bg-main);
    color: var(--color-text-main);
    min-height: 100vh;
    padding: 24px;
    line-height: 1.5;
  }
  h1 { font-size: 1.6rem; color: var(--color-primary); margin-bottom: 4px; }
  h2 { font-size: 1.2rem; color: var(--color-accent-gold); margin: 24px 0 12px; }
  h3 { font-size: 1rem; color: var(--color-link); margin: 16px 0 8px; }
  .sub { color: var(--color-text-muted); font-size: 0.85rem; margin-bottom: 16px; }
  .muted { color: var(--color-text-muted); font-size: 0.8rem; }
  code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem; color: var(--color-accent-peach); background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; }
  .kpis { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  .kpi { background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 10px; padding: 14px 18px; min-width: 140px; flex: 1; }
  .kpi-val { font-size: 1.4rem; font-weight: 700; }
  .kpi-label { font-size: 0.75rem; color: var(--color-text-muted); margin-top: 4px; }
  .card { background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 12px; padding: 18px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--color-border); color: var(--color-accent-gold); font-weight: 600; }
  td { padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  tr:hover td { background: rgba(255,255,255,0.03); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; font-weight: 600; }
  .badge-ok { background: var(--color-primary); color: #fff; }
  .badge-warn { background: var(--color-accent-gold); color: var(--color-dark); }
  .badge-err { background: var(--color-primary-hover); color: #fff; }
  .footer { text-align: center; color: var(--color-text-muted); font-size: 0.75rem; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--color-border); }
  @media print {
    body { background: #fff !important; color: #222 !important; }
    .card, .kpi { background: #f7d4ca !important; border-color: rgba(34,34,34,0.15) !important; }
    .muted, .sub { color: #712d23 !important; }
    h1 { color: #F05F40 !important; }
    h2, h3 { color: #cc7501 !important; }
    th { color: #cc7501 !important; }
    code { color: #712d23 !important; }
  }
  @media (max-width: 768px) { .kpis { flex-direction: column; } }
</style>
</head>
<body>
<h1>💧 Drenagem de Liquidez — CAS</h1>
<p class="sub">Rede: <b>Polygon PoS Mainnet</b> · Chain ID: 137 · Bloco: ${meta.blockNumber} · Timestamp: ${meta.iso}</p>

<div class="kpis">${kpiHtml}</div>

<h2>📋 Metadata</h2>
<div class="card">
  <table>
    <tr><th>Campo</th><th>Valor</th></tr>
    <tr><td>CAS Token</td><td>${polyScanLink(meta.casToken, meta.casToken)}</td></tr>
    <tr><td>LP Lock</td><td>${polyScanLink(meta.lock, meta.lock)}</td></tr>
    <tr><td>Deployer</td><td>${polyScanLink(meta.deployer, meta.deployer)}</td></tr>
    <tr><td>V3 Factory</td><td>${polyScanLink(meta.v3Factory, meta.v3Factory)}</td></tr>
    <tr><td>V3 Position Manager</td><td>${polyScanLink(meta.v3PosManager, meta.v3PosManager)}</td></tr>
    <tr><td>Resgatado do lock</td><td>${withdrawnFromLock.length > 0 ? escapeHtml(withdrawnFromLock.join(", ")) : "nenhum"}</td></tr>
  </table>
</div>

<h2>📊 DEXs V2 — Drenagem</h2>
<div class="card">
  <table>
    <thead><tr><th>DEX</th><th>Par LP</th><th>CAS reserva</th><th>Outra reserva</th><th>Status</th></tr></thead>
    <tbody>${v2Rows || '<tr><td colspan="5" class="muted">Nenhum par V2 encontrado</td></tr>'}</tbody>
  </table>
</div>

<h2>🏊 Uniswap V3 — Drenagem</h2>
<div class="card">
  <h3>Posições do Deployer</h3>
  <table>
    <thead><tr><th>Posição</th><th>Pool</th><th>Fee</th><th>Outro token</th><th>Liquidez</th><th>Status</th></tr></thead>
    <tbody>${v3Rows || '<tr><td colspan="6" class="muted">Nenhuma posição V3 encontrada</td></tr>'}</tbody>
  </table>
</div>

<h2>🔍 Pools V3 Encontradas</h2>
<div class="card">
  <table>
    <thead><tr><th>Pool</th><th>Fee</th><th>Outro token</th><th>Liquidez</th></tr></thead>
    <tbody>${poolRows || '<tr><td colspan="4" class="muted">Nenhuma pool V3 encontrada</td></tr>'}</tbody>
  </table>
</div>

<div class="footer">
  Drenagem executada em ${meta.iso} · Polygon PoS Mainnet · Bloco ${meta.blockNumber}<br>
  Rapport Tecnologia — AgenticSpace
</div>
</body>
</html>`;
}

main().catch((err) => {
  console.error(`\n  Erro fatal: ${err.message ?? err}`);
  process.exit(1);
});
