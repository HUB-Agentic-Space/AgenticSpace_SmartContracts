/**
 * @file 27_mint_cas_csv.ts
 * @notice Mint em lote de CAS a partir de um arquivo CSV com as contas
 *         destino e a quantidade de CAS a cunhar para cada uma.
 * @dev    Formato do CSV (header obrigatório, nomes flexíveis):
 *           name, email, whatsapp, address, amount, brla_value, usdc_value
 *
 *         Para cada linha válida chama `CASToken.mint(address, amount)` — o
 *         mint já credita diretamente a conta destino (Transfer de 0x0),
 *         portanto "mint + transferência" é uma única transação por conta.
 *         Requer que o signer (POLYGON_PRIVATE_KEY / POLYGON_AMOY_PRIVATE_KEY)
 *         detenha MINTER_ROLE no CAS.
 *
 *         Preenchimento automático: se `brla_value` e/ou `usdc_value` estiver
 *         vazio, o valor equivalente ao CAS mintado é calculado no momento do
 *         mint e gravado de volta no próprio CSV. Na Polygon mainnet (137) o
 *         preço é derivado on-chain: spot SushiSwap WPOL/CAS × Chainlink
 *         POL/USD e feed BRL/USD. Fora da mainnet use `CAS_USD_PRICE` e
 *         `BRL_USD_PRICE` (USD por unidade, ex.: 0.0001331 e 0.1818).
 *
 *         Colunas de auditoria acrescentadas automaticamente (se ausentes):
 *           tx_hash   — hash da tx de mint; linha com tx_hash é PULADA
 *                       (re-execução idempotente após falha parcial).
 *           minted_at — timestamp ISO da confirmação.
 *         O CSV é reescrito após cada mint confirmado; uma cópia do arquivo
 *         original é salva em `<arquivo>.bak` na primeira escrita.
 *
 *         Regras de segurança respeitadas: aborta se qualquer linha pendente
 *         tiver endereço inválido, amount <= 0, destino congelado, supply
 *         estourar MAX_SUPPLY, contrato pausado, voting lock ativo ou signer
 *         sem MINTER_ROLE. DRY_RUN é o padrão — só envia tx com DRY_RUN=false.
 *
 *         Uso:
 *           MINT_CSV=data/mint-2026-11-30.csv DRY_RUN=true \
 *             npx hardhat run scripts/casswap/27_mint_cas_csv.ts --network polygon
 *           MINT_CSV=data/mint-2026-11-30.csv DRY_RUN=false \
 *             npx hardhat run scripts/casswap/27_mint_cas_csv.ts --network polygon
 *
 *         O caminho do CSV também pode ser passado como argumento posicional
 *         (qualquer token da linha de comando terminado em `.csv`).
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

import "dotenv/config";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  SEP,
  SUB,
  getNetworkInfo,
  requireEnv,
  preFlightCheck,
  sendAndVerify,
  printSummary,
} from "../utils/deploy_helpers";
import { parseCsv } from "../utils/cas_csv_import";

const FILE = "scripts/casswap/27_mint_cas_csv.ts";
const SC_ROOT = path.resolve(__dirname, "..", "..");

// ── Endereços de referência de preço (Polygon mainnet, chainId 137) ────
const SUSHI_WPOL_CAS = "0x265D86d4D43c32037b032097e8bFB6893E1C3964";
const FEED_POL_USD = "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0";
const FEED_BRL_USD = "0xB90DA3ff54C3ED09115abf6FbA0Ff4645586af2c";

const GAS_EST_MINT = 150_000n;

const CAS_ABI = [
  "function mint(address to, uint256 amount)",
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function paused() view returns (bool)",
  "function isFrozen(address account) view returns (bool)",
  "function isVotingLockActive() view returns (bool)",
  "function MINTER_ROLE() view returns (bytes32)",
];

const CL_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];
const SUSHI_PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";
function log(level: LogLevel, fn: string, msg: string, p?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const e = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  console.log(`[${ts}] [${FILE}:${fn}] ${e} ${msg}${p ? ` - ${JSON.stringify(p)}` : ""}`);
}

// ── CSV: localização do arquivo ───────────────────────────────────────

/** Resolve o caminho do CSV: env MINT_CSV ou argumento posicional *.csv. */
function resolveCsvPath(): string {
  const envPath = (process.env.MINT_CSV ?? "").trim();
  if (envPath) return path.isAbsolute(envPath) ? envPath : path.join(SC_ROOT, envPath);
  const arg = process.argv.find((a) => a.toLowerCase().endsWith(".csv"));
  if (arg) return path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  console.log(`\n  ERRO: informe o CSV via MINT_CSV=<arquivo> ou argumento posicional .csv`);
  console.log(`  Ex.: MINT_CSV=data/mint-2026-11-30.csv npx hardhat run ${FILE} --network polygon\n`);
  process.exit(1);
}

// ── CSV: mapeamento de colunas ────────────────────────────────────────

/** Normaliza header: minúsculas, sem acento, sem separadores. */
function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const ADDR_SET = new Set(["address", "addr", "wallet", "carteira", "endereco", "publickey", "recipient", "destino", "to"]);
const AMOUNT_SET = new Set(["amount", "quantidade", "qtd", "qtde", "cas", "casamount", "amountcas", "valor"]);
const BRLA_SET = new Set(["brlavalue", "brla", "brl", "valorbrla", "brlvalue"]);
const USDC_SET = new Set(["usdcvalue", "usdc", "usd", "valorusd", "valorusdc", "usdvalue"]);
const TXHASH_SET = new Set(["txhash", "tx", "hash", "minttx", "transactionhash", "txnhash"]);
const MINTED_SET = new Set(["mintedat", "datamint", "mintdate", "minted", "timestamp"]);

interface ColMap {
  address: number;
  amount: number;
  brla: number;
  usdc: number;
  txHash: number;
  mintedAt: number;
}

/** Mapeia o header para índices de coluna; exige address e amount. */
function mapColumns(header: string[]): ColMap {
  const map: ColMap = { address: -1, amount: -1, brla: -1, usdc: -1, txHash: -1, mintedAt: -1 };
  header.forEach((h, i) => {
    const n = normalizeHeader(h);
    if (map.address < 0 && ADDR_SET.has(n)) map.address = i;
    else if (map.amount < 0 && AMOUNT_SET.has(n)) map.amount = i;
    else if (map.brla < 0 && BRLA_SET.has(n)) map.brla = i;
    else if (map.usdc < 0 && USDC_SET.has(n)) map.usdc = i;
    else if (map.txHash < 0 && TXHASH_SET.has(n)) map.txHash = i;
    else if (map.mintedAt < 0 && MINTED_SET.has(n)) map.mintedAt = i;
  });
  if (map.address < 0 || map.amount < 0) {
    console.log(`\n  ERRO: header do CSV precisa das colunas 'address' e 'amount'.`);
    console.log(`  Header lido: ${header.join(" | ")}\n`);
    process.exit(1);
  }
  return map;
}

/** Garante que o header contém as colunas de auditoria; retorna header final. */
function ensureColumns(header: string[], map: ColMap): string[] {
  const out = [...header];
  if (map.brla < 0) { map.brla = out.length; out.push("brla_value"); }
  if (map.usdc < 0) { map.usdc = out.length; out.push("usdc_value"); }
  if (map.txHash < 0) { map.txHash = out.length; out.push("tx_hash"); }
  if (map.mintedAt < 0) { map.mintedAt = out.length; out.push("minted_at"); }
  return out;
}

/** Detecta o delimitador dominante (, ou ;). */
function detectDelimiter(content: string): string {
  const sample = content.split(/\r?\n/).slice(0, 5).join("\n");
  const commas = (sample.match(/,/g) || []).length;
  const semicolons = (sample.match(/;/g) || []).length;
  return semicolons > commas ? ";" : ",";
}

/** Escapa um campo se contiver delimitador, aspas ou quebra de linha. */
function csvField(f: string, delim: string): string {
  return f.includes(delim) || f.includes('"') || f.includes("\n")
    ? `"${f.replace(/"/g, '""')}"`
    : f;
}

/** Reescreve o CSV completo (header + linhas) com o delimitador original. */
function writeCsv(file: string, header: string[], rows: string[][], delim: string): void {
  const lines = [header, ...rows].map((r) => r.map((f) => csvField(f, delim)).join(delim));
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

// ── Parsing de valores ────────────────────────────────────────────────

/**
 * Converte um número em texto para decimal com ponto.
 * Aceita "1000", "1000.5" (US), "1.000,5" ou "1,5" (pt-BR, dentro de aspas).
 */
function parseDecimal(raw: string): string {
  let s = raw.trim().replace(/\s+/g, "");
  if (s.includes(",")) {
    if (s.includes(".")) {
      // último separador decide o formato: "1.000,5" (pt-BR) ou "1,000.5" (US)
      s = s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
    } else {
      s = s.replace(",", ".");
    }
  }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`valor inválido: "${raw}"`);
  return s;
}

/** CAS em wei a partir do campo amount. */
function parseAmountWei(raw: string): bigint {
  return ethers.parseUnits(parseDecimal(raw), 18);
}

/** USD/BRL em micro-unidades (6 casas) a partir de um campo de valor. */
function parseValue6(raw: string): bigint {
  return ethers.parseUnits(parseDecimal(raw), 6);
}

/** Formata um bigint escalado (scale decimais) com 6 casas. */
function fmt6(v: bigint, scale: number): string {
  const scaled = scale === 6 ? v : (v * 10n ** 6n) / 10n ** BigInt(scale);
  const int = scaled / 10n ** 6n;
  const frac = (scaled % 10n ** 6n).toString().padStart(6, "0");
  return `${int}.${frac}`;
}

// ── Preço de referência ───────────────────────────────────────────────

interface PriceRef {
  /** USD por 1 CAS inteiro, escala 1e8 (Chainlink). */
  casUsdE8: bigint;
  /** USD por 1 BRL, escala 1e8. */
  brlUsdE8: bigint;
  source: string;
}

async function feedPrice(provider: any, feed: string): Promise<bigint> {
  const c = new ethers.Contract(feed, CL_ABI, provider);
  const [, answer] = await c.latestRoundData();
  return BigInt(answer);
}

/**
 * Deriva CAS/USD e BRL/USD. Na mainnet usa SushiSwap WPOL/CAS × Chainlink
 * POL/USD e feed BRL/USD; fora dela (ou com override) usa CAS_USD_PRICE /
 * BRL_USD_PRICE do ambiente.
 */
async function getPriceRef(provider: any, chainId: number): Promise<PriceRef | null> {
  const casUsdEnv = (process.env.CAS_USD_PRICE ?? "").trim();
  const brlUsdEnv = (process.env.BRL_USD_PRICE ?? "").trim();
  if (casUsdEnv && brlUsdEnv) {
    return {
      casUsdE8: ethers.parseUnits(parseDecimal(casUsdEnv), 8),
      brlUsdE8: ethers.parseUnits(parseDecimal(brlUsdEnv), 8),
      source: "env (CAS_USD_PRICE/BRL_USD_PRICE)",
    };
  }
  if (chainId !== 137) {
    return null;
  }
  const [polUsdE8, brlUsdE8] = await Promise.all([
    feedPrice(provider, FEED_POL_USD),
    feedPrice(provider, FEED_BRL_USD),
  ]);
  const sushi = new ethers.Contract(SUSHI_WPOL_CAS, SUSHI_PAIR_ABI, provider);
  const [rWpol, rCas] = await sushi.getReserves(); // token0=WPOL, token1=CAS
  const casUsdE8 = (polUsdE8 * BigInt(rWpol)) / BigInt(rCas);
  return { casUsdE8, brlUsdE8, source: "mercado (SushiSwap + Chainlink)" };
}

// ── Estrutura de linha ────────────────────────────────────────────────

interface MintRow {
  fields: string[];      // campos na ordem do header final
  lineNo: number;        // número da linha no arquivo (1-based, pós-header)
  name: string;
  address: string;
  amountWei: bigint;
  skip: boolean;         // já mintada (tx_hash preenchido)
}

function cell(fields: string[], i: number): string {
  return i >= 0 && i < fields.length ? fields[i].trim() : "";
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Mint em lote de CAS via CSV");
  console.log(SEP);

  const dryRun = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
  const env = requireEnv(["CAS_TOKEN_ADDRESS"]);

  // ── Ler e mapear o CSV ─────────────────────────────────────────────
  const csvPath = resolveCsvPath();
  if (!fs.existsSync(csvPath)) {
    console.log(`\n  ERRO: arquivo não encontrado: ${csvPath}\n`);
    process.exit(1);
  }
  const content = fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "");
  const delim = detectDelimiter(content);
  const table = parseCsv(content);
  if (table.length < 1) {
    console.log(`\n  ERRO: CSV vazio: ${csvPath}\n`);
    process.exit(1);
  }
  const colMap = mapColumns(table[0]);
  const header = ensureColumns(table[0], colMap);

  // ── Parse e validação das linhas ───────────────────────────────────
  const rows: MintRow[] = [];
  const errors: string[] = [];
  const NAME_COL = table[0].findIndex((h) => ["name", "nome"].includes(normalizeHeader(h)));

  for (let i = 1; i < table.length; i++) {
    // completa campos faltantes para alinhar ao header final
    const fields = [...table[i]];
    while (fields.length < header.length) fields.push("");
    const lineNo = i + 1;
    const rawAddr = cell(fields, colMap.address);
    const rawAmount = cell(fields, colMap.amount);
    const name = NAME_COL >= 0 ? cell(fields, NAME_COL) : "";

    if (cell(fields, colMap.txHash)) {
      rows.push({ fields, lineNo, name, address: rawAddr, amountWei: 0n, skip: true });
      continue;
    }
    if (!ethers.isAddress(rawAddr)) {
      errors.push(`linha ${lineNo}: address inválido "${rawAddr}"`);
      continue;
    }
    let amountWei: bigint;
    try {
      amountWei = parseAmountWei(rawAmount);
    } catch (e) {
      errors.push(`linha ${lineNo}: ${(e as Error).message}`);
      continue;
    }
    if (amountWei <= 0n) {
      errors.push(`linha ${lineNo}: amount deve ser > 0 ("${rawAmount}")`);
      continue;
    }
    rows.push({
      fields,
      lineNo,
      name,
      address: ethers.getAddress(rawAddr),
      amountWei,
      skip: false,
    });
  }
  // erro de validação em colunas de valor já preenchidas
  for (const r of rows) {
    if (r.skip) continue;
    for (const [col, label] of [[colMap.brla, "brla_value"], [colMap.usdc, "usdc_value"]] as const) {
      const v = cell(r.fields, col);
      if (v) {
        try { parseDecimal(v); } catch { errors.push(`linha ${r.lineNo}: ${label} inválido "${v}"`); }
      }
    }
  }

  const pending = rows.filter((r) => !r.skip);
  const skipped = rows.length - pending.length;

  if (errors.length > 0) {
    console.log(`\n${SUB}\n  ERROS no CSV — nada será mintado\n${SUB}`);
    for (const e of errors) console.log(`  - ${e}`);
    console.log();
    process.exit(1);
  }
  if (pending.length === 0) {
    console.log(`\n  Nenhuma linha pendente (${skipped} já mintadas). Nada a fazer.\n`);
    return;
  }

  const totalCas = pending.reduce((s, r) => s + r.amountWei, 0n);

  // ── Rede, signer e contrato ────────────────────────────────────────
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;
  const chainId = Number((await provider.getNetwork()).chainId);
  const netInfo = getNetworkInfo(chainId);
  const cas = new ethers.Contract(env.CAS_TOKEN_ADDRESS, CAS_ABI, deployer);

  console.log(`\n${SUB}\n  Rede\n${SUB}`);
  console.log(`  Rede:     ${netInfo.name} (${chainId})`);
  console.log(`  Modo:     ${dryRun ? "DRY-RUN (nenhuma tx será enviada)" : "EXECUÇÃO"}`);
  console.log(`  Signer:   ${deployer.address}`);
  console.log(`  CSV:      ${csvPath}`);
  console.log(`  Linhas:   ${pending.length} pendentes, ${skipped} já mintadas`);
  console.log(`  Total:    ${ethers.formatEther(totalCas)} CAS`);

  // ── Checagens de permissão e estado do contrato ────────────────────
  const minterRole = await cas.MINTER_ROLE();
  const [isMinter, paused, votingLock] = await Promise.all([
    cas.hasRole(minterRole, deployer.address),
    cas.paused(),
    cas.isVotingLockActive().catch(() => false),
  ]);
  if (!isMinter) {
    log("ERROR", "main", "Signer sem MINTER_ROLE no CAS", { signer: deployer.address });
    process.exit(1);
  }
  if (paused) {
    log("ERROR", "main", "CASToken pausado — mint impossível");
    process.exit(1);
  }
  if (votingLock) {
    log("ERROR", "main", "Voting lock ativo — transfers/mints bloqueados para contas sem COMPLIANCE_ROLE");
    process.exit(1);
  }

  // ── Checagem de supply e contas congeladas ─────────────────────────
  const [supply, maxSupply] = await Promise.all([cas.totalSupply(), cas.maxSupply()]);
  if (supply + totalCas > maxSupply) {
    log("ERROR", "main", "Mint excede MAX_SUPPLY", {
      supply: ethers.formatEther(supply),
      total: ethers.formatEther(totalCas),
      maxSupply: ethers.formatEther(maxSupply),
    });
    process.exit(1);
  }
  console.log(`  Supply:   ${ethers.formatEther(supply)} CAS → ${ethers.formatEther(supply + totalCas)} (máx ${ethers.formatEther(maxSupply)})`);

  const frozen: string[] = [];
  for (const r of pending) {
    if (await cas.isFrozen(r.address).catch(() => false)) {
      frozen.push(`linha ${r.lineNo}: ${r.address}`);
    }
  }
  if (frozen.length > 0) {
    console.log(`\n${SUB}\n  Destinos CONGELADOS (AccountFrozen)\n${SUB}`);
    for (const f of frozen) console.log(`  - ${f}`);
    process.exit(1);
  }

  // ── Preço de referência (só se houver coluna vazia a preencher) ────
  const needsPrice = pending.some((r) => !cell(r.fields, colMap.brla) || !cell(r.fields, colMap.usdc));
  let price: PriceRef | null = null;
  if (needsPrice) {
    price = await getPriceRef(provider, chainId);
    if (!price) {
      log("ERROR", "main", "Sem fonte de preço nesta rede — defina CAS_USD_PRICE e BRL_USD_PRICE no ambiente", { chainId });
      process.exit(1);
    }
    console.log(`\n${SUB}\n  Preço de referência (${price.source})\n${SUB}`);
    console.log(`  1 CAS = $${Number(price.casUsdE8) / 1e8} | BRL/USD = $${Number(price.brlUsdE8) / 1e8}`);
  }

  // ── Calcular valores que serão preenchidos ─────────────────────────
  interface PlannedFill { brla: string; usdc: string }
  const fills = new Map<number, PlannedFill>();
  for (const r of pending) {
    if (!price) break;
    // CAS→USD (1e8): amountWei × casUsdE8 / 1e18
    let usdc6: bigint;
    let brla18: bigint;
    const hasUsdc = cell(r.fields, colMap.usdc) !== "";
    const hasBrla = cell(r.fields, colMap.brla) !== "";
    if (hasUsdc) {
      usdc6 = parseValue6(cell(r.fields, colMap.usdc));
      brla18 = hasBrla ? 0n : (usdc6 * 10n ** 20n) / price.brlUsdE8;
    } else {
      const usdE8 = (r.amountWei * price.casUsdE8) / 10n ** 18n;
      usdc6 = usdE8 / 100n; // 1e8 → 1e6
      brla18 = hasBrla ? 0n : (usdE8 * 10n ** 18n) / price.brlUsdE8;
    }
    let usdcStr = hasUsdc ? cell(r.fields, colMap.usdc) : fmt6(usdc6, 6);
    let brlaStr = hasBrla ? cell(r.fields, colMap.brla) : fmt6(brla18, 18);
    if (!hasUsdc && hasBrla) {
      // brla informado, usdc vazio: derivar usdc = brla × BRL/USD
      const brlaIn = ethers.parseUnits(parseDecimal(cell(r.fields, colMap.brla)), 18);
      usdcStr = fmt6((brlaIn * price.brlUsdE8) / 10n ** 18n / 100n, 6);
    }
    fills.set(r.lineNo, { brla: brlaStr, usdc: usdcStr });
  }

  // ── Plano de execução ──────────────────────────────────────────────
  console.log(`\n${SUB}\n  Plano de mint\n${SUB}`);
  for (const r of pending) {
    const f = fills.get(r.lineNo);
    const vals = f ? ` | BRLA ${f.brla} | USDC ${f.usdc}` : "";
    console.log(`  L${r.lineNo} ${r.name ? r.name + " — " : ""}${r.address}  ${ethers.formatEther(r.amountWei)} CAS${vals}`);
  }

  const steps = pending.map((r) => ({
    label: `mint → ${r.address.slice(0, 10)}…`,
    gas: GAS_EST_MINT,
  }));
  const { gasPrice, balance } = await preFlightCheck("Mint CAS em lote (CSV)", steps, {
    extraInfo: [
      { label: "Linhas pendentes:", value: `${pending.length}` },
      { label: "Total CAS:", value: `${ethers.formatEther(totalCas)} CAS` },
      { label: "CSV:", value: path.basename(csvPath) },
    ],
  });

  if (dryRun) {
    const relCsv = path.relative(SC_ROOT, csvPath);
    const shownCsv = relCsv.startsWith("..") ? csvPath : relCsv;
    console.log(`\n${SEP}`);
    console.log(`  DRY-RUN concluído — nenhuma transação enviada, CSV não alterado.`);
    console.log(`  Para executar: MINT_CSV=${shownCsv} DRY_RUN=false npx hardhat run ${FILE} --network ${chainId === 137 ? "polygon" : "polygonAmoy"}`);
    console.log(`${SEP}\n`);
    return;
  }

  // ── Execução ───────────────────────────────────────────────────────
  fs.copyFileSync(csvPath, `${csvPath}.bak`);
  log("INFO", "main", "Backup do CSV criado", { bak: `${csvPath}.bak` });

  let minted = 0;
  for (const r of pending) {
    const receipt = await sendAndVerify(
      `mint ${ethers.formatEther(r.amountWei)} CAS → ${r.name ? r.name + " " : ""}${r.address}`,
      cas.mint(r.address, r.amountWei, { gasPrice }) as Promise<any>,
      gasPrice,
    );
    const f = fills.get(r.lineNo);
    r.fields[colMap.brla] = f?.brla ?? cell(r.fields, colMap.brla);
    r.fields[colMap.usdc] = f?.usdc ?? cell(r.fields, colMap.usdc);
    r.fields[colMap.txHash] = receipt.hash;
    r.fields[colMap.mintedAt] = new Date().toISOString();
    // regrava o CSV a cada mint confirmado (progresso persistente)
    writeCsv(csvPath, header, rows.map((x) => x.fields), delim);
    minted += 1;
    log("OK", "main", `mint ${minted}/${pending.length}`, { to: r.address, tx: receipt.hash });
  }

  await printSummary("Mint em lote concluído", [
    { label: "Mintadas:", value: `${minted} contas` },
    { label: "Puladas:", value: `${skipped} (já tinham tx_hash)` },
    { label: "Total CAS:", value: `${ethers.formatEther(totalCas)} CAS` },
    { label: "CSV atualizado:", value: csvPath },
  ], balance, [
    "Conferir os mints no Polygonscan pelos tx_hash gravados no CSV",
    "Rodar npm run sync:cas:db para atualizar o cas_tracker.db",
  ]);
  log("INFO", "main", "🏁 Mint em lote concluído");
}

main().then(() => process.exit(0)).catch((err) => {
  log("ERROR", "main", "Falha", { error: (err as Error).message });
  console.error(err);
  process.exit(1);
});
