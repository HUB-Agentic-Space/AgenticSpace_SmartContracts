import "dotenv/config";
import { ethers } from "hardhat";
import Database from "better-sqlite3";
import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

/** Consolidates only LP owned by the authorised wallet into the canonical Sushi CAS/WPOL pool. */
const CAS = "0x5151A34EaC7bA08cd6B540b32cD30316218A2287";
const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const SUSHI_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";
const SUSHI_PAIR = "0x265d86d4d43c32037b032097e8bfb6893e1c3964";
const ALTERNATIVE_POOLS = [
  { name: "QuickSwap", pair: "0xf77bd26fe17adb1bc99be6cd63414b2a7819690e", router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", native: true },
  { name: "ApeSwap", pair: "0xf27f3c3e305fedf21b491a1d531fd4c3c80312b4", router: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607", native: true },
  // Dfyn is CAS/WETH, so its withdrawal is never silently swapped into POL.
  { name: "Dfyn", pair: "0x2275bfc0b1e26fb36a42e26fa1e5e4d823e62bc3", router: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429", native: false },
] as const;
const PAIR_ABI = [
  "function token0() view returns(address)", "function token1() view returns(address)", "function getReserves() view returns(uint112,uint112,uint32)",
  "function totalSupply() view returns(uint256)", "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
];
const ERC20_ABI = ["function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)", "function approve(address,uint256) returns(bool)"];
const ROUTER_ABI = [
  "function removeLiquidityETH(address,uint256,uint256,uint256,address,uint256) returns(uint256,uint256)",
  "function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) returns(uint256,uint256)",
  "function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns(uint256,uint256,uint256)",
];

type PoolState = { name: string; pair: string; router: string; native: boolean; lp: bigint; casOut: bigint; otherOut: bigint; other: string };
const argv: string[] = process.env.CONSOLIDATE_SUSHI_ARGS ? JSON.parse(process.env.CONSOLIDATE_SUSHI_ARGS) : process.argv;
function arg(name: string): string | undefined { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; }
function usage(): never { throw new Error("Uso: --wallet <endereço> --cas <CAS> --impact-percent <0..100> [--calc | --execute]"); }
function min(value: bigint, bps = 100n): bigint { return value * (10_000n - bps) / 10_000n; }
function ceilDiv(a: bigint, b: bigint): bigint { return (a + b - 1n) / b; }
function validKey(value: string | undefined): value is string { return Boolean(value && /^0x[0-9a-fA-F]{64}$/.test(value)); }
function dbKey(payloadText: string, master: string): string {
  const p = JSON.parse(payloadText) as { iv: string; tag: string; data: string }; const k = Buffer.from(master, "hex");
  if (k.length !== 32) throw new Error("WALLET_MASTER_KEY inválida");
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(p.iv, "base64")); d.setAuthTag(Buffer.from(p.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(p.data, "base64")), d.final()]).toString("utf8");
}
function findKey(owner: string): string {
  const found: string[] = [];
  for (const [name, value] of Object.entries(process.env)) if (name.includes("PRIVATE") && validKey(value) && new ethers.Wallet(value).address.toLowerCase() === owner.toLowerCase()) found.push(value);
  const root = path.resolve(process.cwd(), "../rapport_trader"), envFile = path.join(root, ".env"), dbFile = path.join(root, "data/cas_tracker.db");
  if (existsSync(envFile) && existsSync(dbFile)) {
    const env = dotenv.parse(readFileSync(envFile));
    if (env.WALLET_MASTER_KEY) { const db = new Database(dbFile, { readonly: true }); try {
      const row = db.prepare("SELECT private_key_encrypted FROM trader_wallets WHERE lower(address)=lower(?) AND active=1").get(owner) as { private_key_encrypted?: string } | undefined;
      if (row?.private_key_encrypted) { const key = dbKey(row.private_key_encrypted, env.WALLET_MASTER_KEY); if (!validKey(key) || new ethers.Wallet(key).address.toLowerCase() !== owner.toLowerCase()) throw new Error("Chave do banco não corresponde a --wallet"); found.push(key); }
    } finally { db.close(); } }
  }
  const unique = [...new Set(found)];
  if (unique.length !== 1) throw new Error(unique.length ? "Mais de uma chave diferente encontrada para --wallet" : "Nenhuma chave válida encontrada para --wallet");
  return unique[0];
}

async function readPool(name: string, pairAddress: string, router: string, native: boolean, owner: string, provider: typeof ethers.provider): Promise<PoolState> {
  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const [token0, reserves, supply, lp] = await Promise.all([pair.token0(), pair.getReserves(), pair.totalSupply(), pair.balanceOf(owner)]);
  const cas0 = token0.toLowerCase() === CAS.toLowerCase();
  const casReserve = BigInt(cas0 ? reserves[0] : reserves[1]);
  const otherReserve = BigInt(cas0 ? reserves[1] : reserves[0]);
  return { name, pair: pairAddress, router, native, lp: BigInt(lp), casOut: supply === 0n ? 0n : BigInt(lp) * casReserve / BigInt(supply), otherOut: supply === 0n ? 0n : BigInt(lp) * otherReserve / BigInt(supply), other: cas0 ? await pair.token1() : token0 };
}

async function main() {
  const casText = arg("--cas"); const impactText = arg("--impact-percent"); const walletText = arg("--wallet");
  if (!casText || !impactText || !walletText || !ethers.isAddress(walletText) || arg("--calc") && arg("--execute")) usage();
  const owner = ethers.getAddress(walletText);
  const sellCas = ethers.parseEther(casText);
  const impact = Number(impactText);
  if (sellCas <= 0n || !Number.isFinite(impact) || impact <= 0 || impact >= 100) usage();
  const provider = ethers.provider;
  if (Number((await provider.getNetwork()).chainId) !== 137) throw new Error("Abortado: use exclusivamente --network polygon (chainId 137)");

  const sushi = await readPool("SushiSwap", SUSHI_PAIR, SUSHI_ROUTER, true, owner, provider);
  if (sushi.other.toLowerCase() !== WPOL.toLowerCase()) throw new Error("Par Sushi inesperado: não é CAS/WPOL");
  // Constant-product approximation: post-trade marginal-price impact <= requested percentage, 30 bps fee.
  const d = impact / 100;
  const targetCas = ethers.parseEther((((1 - 0.003) * Number(ethers.formatEther(sellCas))) / (1 / Math.sqrt(1 - d) - 1)).toFixed(18));
  const pair = new ethers.Contract(SUSHI_PAIR, PAIR_ABI, provider);
  const reserves = await pair.getReserves(); const token0 = await pair.token0(); const cas0 = token0.toLowerCase() === CAS.toLowerCase();
  const sushiCas = BigInt(cas0 ? reserves[0] : reserves[1]); const sushiPol = BigInt(cas0 ? reserves[1] : reserves[0]);
  const neededCas = targetCas > sushiCas ? targetCas - sushiCas : 0n;
  const neededPol = neededCas === 0n ? 0n : ceilDiv(neededCas * sushiPol, sushiCas);
  const alternatives = [] as PoolState[];
  for (const p of ALTERNATIVE_POOLS) alternatives.push(await readPool(p.name, p.pair, p.router, p.native, owner, provider));
  const casToken = new ethers.Contract(CAS, ERC20_ABI, provider);
  const [walletCas, walletPol] = await Promise.all([casToken.balanceOf(owner), provider.getBalance(owner)]);
  const recoveredCas = alternatives.reduce((n, p) => n + p.casOut, 0n);
  const recoveredPol = alternatives.filter(p => p.native).reduce((n, p) => n + p.otherOut, 0n);
  console.log(`\nSushi alvo para venda de ${casText} CAS com impacto <= ${impactText}%`);
  console.log(`Reserva atual: ${ethers.formatEther(sushiCas)} CAS + ${ethers.formatEther(sushiPol)} WPOL`);
  console.log(`Reserva alvo:  ${ethers.formatEther(targetCas)} CAS + ${ethers.formatEther(ceilDiv(targetCas * sushiPol, sushiCas))} WPOL`);
  console.log(`Aporte Sushi:  ${ethers.formatEther(neededCas)} CAS + ${ethers.formatEther(neededPol)} POL`);
  console.log(`Carteira:      ${owner}\nSaldo: ${ethers.formatEther(walletCas)} CAS + ${ethers.formatEther(walletPol)} POL`);
  for (const p of alternatives) console.log(`${p.name}: LP próprio ${ethers.formatEther(p.lp)}; retirada estimada ${ethers.formatEther(p.casOut)} CAS + ${ethers.formatEther(p.otherOut)} ${p.native ? "POL" : "WETH"}`);
  console.log(`Recuperável para Sushi sem swaps: ${ethers.formatEther(recoveredCas)} CAS + ${ethers.formatEther(recoveredPol)} POL`);
  if (arg("--calc")) return;
  if (!arg("--execute")) { console.log("\nPlano somente. Para enviar transações, acrescente --execute após revisar estes valores."); return; }
  const signer = new ethers.Wallet(findKey(owner), provider);
  if (BigInt(walletCas) + recoveredCas < neededCas || BigInt(walletPol) + recoveredPol < neededPol) throw new Error("Saldo projetado insuficiente para o aporte; nenhuma transação foi enviada.");
  const deadline = Math.floor(Date.now() / 1000) + 600;
  for (const p of alternatives) {
    if (p.lp === 0n) continue;
    const lp = new ethers.Contract(p.pair, PAIR_ABI, signer); const router = new ethers.Contract(p.router, ROUTER_ABI, signer);
    await (await lp.approve(p.router, p.lp)).wait();
    if (p.native) await (await router.removeLiquidityETH(CAS, p.lp, min(p.casOut), min(p.otherOut), owner, deadline)).wait();
    else await (await router.removeLiquidity(CAS, p.other, p.lp, min(p.casOut), min(p.otherOut), owner, deadline)).wait();
  }
  const writableCas = new ethers.Contract(CAS, ERC20_ABI, signer); const router = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, signer);
  if (BigInt(await writableCas.allowance(owner, SUSHI_ROUTER)) < neededCas) await (await writableCas.approve(SUSHI_ROUTER, neededCas)).wait();
  await (await router.addLiquidityETH(CAS, neededCas, min(neededCas, 50n), min(neededPol, 50n), owner, deadline, { value: neededPol })).wait();
  console.log("Consolidação concluída. Confirme as reservas on-chain antes de mudar fontes de preço.");
}
main().catch(error => { console.error(error.message ?? error); process.exitCode = 1; });
