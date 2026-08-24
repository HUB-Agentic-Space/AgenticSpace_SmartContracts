/**
 * CAS CSV Import — importação semântica de endereços a partir de qualquer CSV.
 *
 * Varrer todos os arquivos *.csv de um diretório e identificar automaticamente
 * as colunas relevantes (nome, endereço, observação/descrição, tipo, moeda).
 *
 * Padrões: parsing CSV manual (suporta vírgulas dentro de aspas), detecção
 * heurística de header e conteúdo, normalização de tipo/asset.
 */

import * as fs from "fs";
import * as path from "path";
import { WhitelistService } from "agentic_space_commons";
import { getDB, upsertAddress, setAddressName, setNotes, getAddress, addAddressRole, getCsvImportTime, setCsvImportTime } from "./cas_database";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const NAME_KEYWORDS = [
  "nome", "name", "titular", "identificacao", "identificação", "titulo", "título",
  "conta", "usuario", "usuário", "user", "owner", "dono", "pessoa", "label",
  "rotulo", "rótulo", "denominacao", "denominação", "identificador",
];
const ADDRESS_KEYWORDS = [
  "endereco", "endereço", "address", "addr", "wallet", "carteira",
  "conta", "publickey", "public", "chave", "chavepublica",
];
const OBS_KEYWORDS = [
  "obs", "observacao", "observação", "nota", "note", "descricao", "descrição",
  "description", "comentario", "comentário", "comment", "detalhe", "detail",
  "desc", "info", "informacao", "informação", "anotacao", "anotação",
  "motivo", "justificativa", "justification", "causa", "cause", "razao", "razão",
];
const TYPE_KEYWORDS = [
  "tipo", "type", "classe", "class", "kind", "categoria", "category",
  "wallet", "carteira", "natureza", "perfil", "funcao", "função", "papel",
];
const ASSET_KEYWORDS = [
  "moeda", "asset", "currency", "coin", "ativo", "token", "symbol",
  "simbolo", "símbolo", "networkmoeda", "network", "rede", "chain",
  "moedanetwork", "redemoeda", "ativo", "ticker",
];
const NETWORK_NAMES = new Set(["POL", "POLYGON", "ETH", "ETHEREUM", "BSC", "BNB", "AVAX", "AVALANCHE", "ARBITRUM", "ARB", "OPTIMISM", "OP", "BASE", "SOL", "SOLANA", "MAINNET", "TESTNET"]);

export interface ColumnMapping {
  nameCol: number;
  addressCol: number;
  obsCol: number;
  typeCol: number;
  assetCol: number;
}

export interface ImportResult {
  file: string;
  imported: number;
  columns: ColumnMapping;
}

function log(level: "INFO" | "WARN" | "ERROR" | "OK", fn: string, msg: string, p?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅" }[level];
  console.log(`[${ts}] [cas_csv_import:${fn}] ${emoji} ${msg}${p ? ` - ${JSON.stringify(p)}` : ""}`);
}

function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function parseCsvLine(line: string, delimiter: string = ","): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (ch === '"') {
      if (inQuotes && line[j + 1] === '"') {
        current += '"';
        j++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function detectDelimiter(content: string): string {
  const firstLines = content.split(/\r?\n/).slice(0, 5).join("\n");
  const commaCount = (firstLines.match(/,/g) || []).length;
  const semicolonCount = (firstLines.match(/;/g) || []).length;
  return semicolonCount > commaCount ? ";" : ",";
}

export function parseCsv(content: string): string[][] {
  const delimiter = detectDelimiter(content);
  return content
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => parseCsvLine(l, delimiter));
}

function scoreHeader(header: string, keywords: string[]): number {
  const norm = normalizeHeader(header);
  for (const kw of keywords) {
    const nkw = normalizeHeader(kw);
    if (norm === nkw || norm.startsWith(nkw) || norm.endsWith(nkw) || norm.includes(nkw)) return 10;
  }
  return 0;
}

function isHeaderLike(row: string[]): boolean {
  if (!row || row.length === 0) return false;
  const allKeywords = [...NAME_KEYWORDS, ...ADDRESS_KEYWORDS, ...OBS_KEYWORDS, ...TYPE_KEYWORDS, ...ASSET_KEYWORDS];
  let keywordMatches = 0;
  for (const f of row) {
    const norm = normalizeHeader(f);
    for (const kw of allKeywords) {
      if (norm.includes(normalizeHeader(kw))) keywordMatches++;
    }
  }
  const nonEmpty = row.filter((f) => f.trim().length > 0);
  if (nonEmpty.length === 0) return false;
  // A header row usually has at least one keyword and few pure data cells (addresses/numbers/short ids)
  const dataCells = nonEmpty.filter((f) => ADDRESS_RE.test(f.trim()) || /^\d+([.,]\d+)*$/.test(f.trim())).length;
  return keywordMatches >= 1 && dataCells < nonEmpty.length / 2;
}

export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    if (isHeaderLike(row)) return i;
    // If a row has mostly addresses, it's data; previous row (if any) is header
    const nonEmpty = row.filter((f) => f.trim().length > 0);
    if (nonEmpty.length === 0) continue;
    const addressCount = nonEmpty.filter((f) => ADDRESS_RE.test(f.trim())).length;
    if (addressCount > nonEmpty.length * 0.5) return i > 0 ? i - 1 : i;
  }
  return 0;
}

function looksLikeAddress(v: string): boolean {
  return ADDRESS_RE.test(v.trim());
}

function isDateTimeLike(v: string): boolean {
  return (
    /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(v) ||
    /^\d{4}-\d{2}-\d{2}/.test(v) ||
    /^\d{1,2}:\d{2}(:\d{2})?$/.test(v) ||
    /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\s+\d{1,2}:\d{2}/.test(v)
  );
}

function looksLikeName(v: string): boolean {
  const t = v.trim();
  return (
    t.length > 2 &&
    t.length < 80 &&
    !looksLikeAddress(t) &&
    !/^\d+([.,]\d+)*$/.test(t) &&
    !isDateTimeLike(t)
  );
}

function looksLikeObs(v: string): boolean {
  const t = v.trim();
  return t.length > 12 && !isDateTimeLike(t);
}

function looksLikeType(v: string): boolean {
  const t = v.trim().toLowerCase();
  return (
    t.length > 0 &&
    t.length < 30 &&
    !looksLikeAddress(t) &&
    !/^\d+([.,]\d+)*$/.test(t) &&
    !isDateTimeLike(t) &&
    !t.startsWith("http")
  );
}

const URL_PROTOCOLS = new Set(["HTTP", "HTTPS", "FTP", "FTPS", "WS", "WSS"]);

function looksLikeAsset(v: string): boolean {
  const t = v.trim();
  return /^[A-Z]{2,8}\b/.test(t) && !looksLikeAddress(t) && !/^\d+$/.test(t) && !URL_PROTOCOLS.has(t.match(/^([A-Z]{2,8})\b/)?.[1] ?? "");
}

export function detectColumns(headers: string[], sampleRows: string[][]): ColumnMapping {
  const colCount = headers.length;
  const valuesByCol = Array.from({ length: colCount }, (_, idx) =>
    sampleRows
      .map((r) => (r[idx] ?? "").trim())
      .filter((v) => v.length > 0)
  );

  const scores = Array.from({ length: colCount }, (_, idx) => {
    const header = headers[idx] ?? "";
    const norm = normalizeHeader(header);
    const values = valuesByCol[idx];

    let nameScore = scoreHeader(header, NAME_KEYWORDS) * 2;
    let addressScore = scoreHeader(header, ADDRESS_KEYWORDS) * 2;
    let obsScore = scoreHeader(header, OBS_KEYWORDS) * 2;
    let typeScore = scoreHeader(header, TYPE_KEYWORDS) * 2;
    let assetScore = scoreHeader(header, ASSET_KEYWORDS) * 2;

    if (values.length > 0) {
      const total = values.length;
      const addrMatches = values.filter((v) => looksLikeAddress(v)).length;
      const hashLike = values.filter((v) => /^0x[0-9a-fA-F]{60,}$/i.test(v)).length;
      const ensLike = values.filter((v) => /\.eth$/i.test(v)).length;
      const addrRatio = addrMatches / total;

      // Strong address content signal; penalize mixed-in transaction hashes / ENS names
      addressScore += addrRatio > 0.7 ? 40 : addrRatio > 0.4 ? 25 : addrRatio > 0.2 ? 10 : 0;
      addressScore -= hashLike * 8;
      addressScore -= ensLike * 4;

      // Name from content: avoid columns that are mostly addresses, numbers or dates
      const nameMatches = values.filter((v) => looksLikeName(v)).length;
      nameScore += nameMatches / total > 0.6 ? 14 : nameMatches / total > 0.3 ? 7 : 0;

      // Observations: long free-form text without looking like structured data
      const obsMatches = values.filter((v) => looksLikeObs(v) && !looksLikeAddress(v) && !/^\d+([.,]\d+)*$/.test(v)).length;
      obsScore += obsMatches / total > 0.5 ? 10 : obsMatches / total > 0.2 ? 5 : 0;

      // Type: short categorical values
      const typeMatches = values.filter((v) => looksLikeType(v)).length;
      typeScore += typeMatches / total > 0.5 ? 10 : typeMatches / total > 0.25 ? 5 : 0;

      // Asset: short uppercase ticker, or known network/token names; exclude plain numbers
      const assetMatches = values.filter(
        (v) => looksLikeAsset(v) || (NETWORK_NAMES.has(v.toUpperCase()) && !/^\d+$/.test(v))
      ).length;
      assetScore += assetMatches / total > 0.5 ? 14 : assetMatches / total > 0.25 ? 7 : 0;

      // If a column has no header but is overwhelmingly addresses, raise address score
      if (addressScore === 0 && addrRatio >= 0.7 && hashLike === 0) addressScore += 40;
    }

    return { idx, nameScore, addressScore, obsScore, typeScore, assetScore, norm };
  });

  const bestAddress = scores.reduce((b, s) => (s.addressScore > b.addressScore ? s : b), scores[0]);
  const addressCol = bestAddress?.addressScore > 0 ? bestAddress.idx : -1;

  const nameCandidates = scores.filter((s) => s.idx !== addressCol);
  const bestName = nameCandidates.reduce((b, s) => (s.nameScore > b.nameScore ? s : b), nameCandidates[0]);
  const nameCol = bestName?.nameScore > 0 ? bestName.idx : -1;

  const obsCandidates = scores.filter((s) => s.idx !== addressCol && s.idx !== nameCol);
  const bestObs = obsCandidates.reduce((b, s) => (s.obsScore > b.obsScore ? s : b), obsCandidates[0]);
  const obsCol = bestObs?.obsScore > 0 ? bestObs.idx : -1;

  const typeCandidates = scores.filter((s) => s.idx !== addressCol && s.idx !== nameCol && s.idx !== obsCol);
  const bestType = typeCandidates.reduce((b, s) => (s.typeScore > b.typeScore ? s : b), typeCandidates[0]);
  const typeCol = bestType?.typeScore > 0 ? bestType.idx : -1;

  const assetCandidates = scores.filter(
    (s) => s.idx !== addressCol && s.idx !== nameCol && s.idx !== obsCol && s.idx !== typeCol,
  );
  const bestAsset = assetCandidates.reduce((b, s) => (s.assetScore > b.assetScore ? s : b), assetCandidates[0]);
  const assetCol = bestAsset?.assetScore > 0 ? bestAsset.idx : -1;

  return { nameCol, addressCol, obsCol, typeCol, assetCol };
}

const CONTRACT_TYPES = new Set([
  "contract", "token", "bridge", "wrapper", "swap", "dex", "lp", "pool", "faucet",
  "migration", "proxy", "diamond", "lock", "reserve", "fund", "multisig",
  "safe", "promotional", "fundtracker", "infrastructure",
  "router", "manager", "factory", "certificate", "tba",
]);

const TYPE_SYNONYMS: Record<string, string> = {
  eoa: "wallet",
  carteira: "wallet",
  pessoa: "wallet",
  holder: "wallet",
  deployer: "wallet",
  admin: "wallet",
  relayer: "wallet",
  operator: "wallet",
  user: "wallet",
  usuario: "wallet",
  contrato: "contract",
  token: "token",
  ponte: "bridge",
  wrapped: "wrapper",
  wrap: "wrapper",
  swap: "swap",
  exchange: "dex",
  amm: "dex",
  liquidity: "dex",
  faucet: "faucet",
  migration: "migration",
  proxy: "proxy",
  diamond: "diamond",
  lock: "lock",
  safe: "safe",
  multisig: "safe",
  reserve: "reserve",
  fund: "fund",
  roteador: "router",
  router: "router",
  route: "router",
  gerenciador: "manager",
  manager: "manager",
  fabrica: "factory",
  fábrica: "factory",
  factory: "factory",
  certificado: "certificate",
  certificate: "certificate",
  tba: "tba",
};

const DIRECT_TYPES = new Set([
  "wallet", "contract", "token", "bridge", "wrapper", "swap", "dex", "lp", "pool", "faucet",
  "migration", "proxy", "diamond", "lock", "reserve", "fund", "multisig", "safe", "airdrop",
  "promotional", "fundtracker", "infrastructure", "eoa", "unknown",
  "router", "manager", "factory", "certificate", "tba",
]);

export function normalizeType(raw: string): string {
  const raw2 = raw.trim().toLowerCase();
  if (!raw2 || /^\d+$/.test(raw2) || raw2.length > 25) return "unknown";
  const norm = normalizeHeader(raw2);
  for (const [key, value] of Object.entries(TYPE_SYNONYMS)) {
    if (norm === key || norm.includes(key)) return value;
  }
  if (DIRECT_TYPES.has(norm)) return norm;
  for (const t of DIRECT_TYPES) {
    if (norm.includes(t)) return t;
  }
  return "unknown";
}

function inferType(label: string, notes: string): string {
  const check = `${label} ${notes}`.toLowerCase();
  const contractWords: [string, string][] = [
    ["bridge", "bridge"],
    ["wrapper", "wrapper"],
    ["ponte", "bridge"],
    ["wrapped", "wrapper"],
    ["swap", "swap"],
    ["dex", "dex"],
    ["faucet", "faucet"],
    ["token", "token"],
    ["diamond", "diamond"],
    ["proxy", "proxy"],
    ["multisig", "safe"],
    ["safe", "safe"],
    ["reserve", "reserve"],
    ["lock", "lock"],
    ["fund tracker", "fundtracker"],
    ["airdrop", "airdrop"],
    ["migration", "migration"],
    ["contrato", "contract"],
    ["contract", "contract"],
    ["promotional", "promotional"],
    ["infrastructure", "infrastructure"],
  ];
  for (const [kw, type] of contractWords) {
    if (check.includes(kw)) return type;
  }
  if (/\b(eoa|wallet|carteira|pessoa|user|usuario|dono|parceiro|estagiario|estagiário|teste|testes|conta|holder)\b/i.test(check)) {
    return "wallet";
  }
  // If it has a name and no contract signal, default to wallet
  if (label.trim().length > 0) return "wallet";
  return "unknown";
}

function inferIsContract(normalizedType: string, label: string, notes: string): boolean {
  if (CONTRACT_TYPES.has(normalizedType)) return true;
  const check = `${label} ${notes}`.toLowerCase();
  return /\b(contrato?|token|bridge|wrapper|swap|dex|lp|pool|faucet|migration|proxy|diamond|lock|reserve|fund|multisig|safe)\b/i.test(check);
}

function inferAsset(normalizedType: string, name: string, notes: string, rawAsset: string): string {
  const KNOWN_ASSETS = new Set([
    "CAS", "CASSWAP", "XLM", "STELLAR", "MATIC", "POL", "POLYGON",
    "ETH", "ETHEREUM", "BSC", "BNB", "USDC", "USDT", "WBTC", "WETH",
    "DAI", "BUSD", "LINK", "UNI", "AAVE", "CRV", "MKR", "AAVE",
  ]);

  const fromNotes = (haystack: string) => {
    // Token tickers embedded in quantity strings such as " CAS 50,0000"
    const tickerMatch = haystack.match(/\b(CAS|CASSWAP|XLM|STELLAR|MATIC|POL|USDC|USDT|WBTC|WETH|DAI|BUSD|LINK|UNI|AAVE|CRV|MKR)\b/);
    if (tickerMatch) return tickerMatch[1];
    if (haystack.includes("BNB") || haystack.includes("BSC")) return "BNB";
    if (haystack.includes("ETH") || haystack.includes("ETHEREUM")) return "ETH";
    if (haystack.includes("POLYGON") || haystack.includes("MATIC")) return "POL";
    if (haystack.includes("SOL") || haystack.includes("SOLANA")) return "SOL";
    return "";
  };

  const raw = rawAsset.trim().toUpperCase();
  const assetMatch = raw.match(/^([A-Z]{2,8})\b/);
  if (assetMatch) {
    const ticker = assetMatch[1];
    if (ticker.length >= 2 && ticker.length <= 12 && !NETWORK_NAMES.has(ticker) && !URL_PROTOCOLS.has(ticker)) {
      return KNOWN_ASSETS.has(ticker) ? ticker : ticker;
    }
  }

  const haystack = `${normalizedType} ${name} ${notes}`.toUpperCase();
  return fromNotes(haystack);
}

function isFraudCsv(fileName: string): boolean {
  return fileName.toLowerCase() === "fraude.csv" || fileName.toLowerCase().includes("fraude");
}

function isWhitelistCsv(fileName: string): boolean {
  return fileName.toLowerCase() === "whitelist.csv" || fileName.toLowerCase().includes("whitelist");
}

function processCsvFile(csvPath: string, forceOverwrite: boolean = false, whitelist?: WhitelistService): ImportResult {
  const fileName = path.basename(csvPath);
  const fraudFile = isFraudCsv(fileName);
  const whitelistFile = isWhitelistCsv(fileName);
  log("INFO", "processCsvFile", "Processando CSV", { file: fileName, forceOverwrite });

  const content = fs.readFileSync(csvPath, "utf-8");
  const allRows = parseCsv(content);
  if (allRows.length < 2) {
    log("WARN", "processCsvFile", "CSV com menos de 2 linhas, pulando", { file: fileName });
    return { file: fileName, imported: 0, columns: { nameCol: -1, addressCol: -1, obsCol: -1, typeCol: -1, assetCol: -1 } };
  }

  const headerIdx = findHeaderRow(allRows);
  const headers = allRows[headerIdx];
  const dataRows = allRows.slice(headerIdx + 1);
  const sampleRows = dataRows.slice(0, 10);

  const columns = detectColumns(headers, sampleRows);
  log("INFO", "processCsvFile", "Colunas detectadas", {
    file: fileName,
    addressCol: columns.addressCol,
    nameCol: columns.nameCol,
    obsCol: columns.obsCol,
    typeCol: columns.typeCol,
    assetCol: columns.assetCol,
  });

  if (columns.addressCol === -1) {
    log("WARN", "processCsvFile", "Nenhuma coluna de endereço encontrada, pulando", { file: fileName });
    return { file: fileName, imported: 0, columns };
  }

  let imported = 0;
  for (const row of dataRows) {
    const rawAddr = (row[columns.addressCol] ?? "").trim();
    if (!ADDRESS_RE.test(rawAddr)) continue;

    const addr = rawAddr.toLowerCase();
    const whitelisted = whitelist?.isWhitelisted(addr) ?? false;

    const name = columns.nameCol >= 0 ? (row[columns.nameCol] ?? "").trim() : "";
    let obs = columns.obsCol >= 0 ? (row[columns.obsCol] ?? "").trim() : "";
    const rawType = columns.typeCol >= 0 ? (row[columns.typeCol] ?? "").trim() : "";
    const rawAsset = columns.assetCol >= 0 ? (row[columns.assetCol] ?? "").trim() : "";

    // Whitelist é a fonte da verdade para endereços isentos de classificação fraudulenta.
    if (whitelisted) {
      addAddressRole(addr, "whitelisted");
      if (fraudFile) {
        log("INFO", "processCsvFile", "Endereço na whitelist — ignorando observação de fraude", { address: addr });
        obs = "";
      }
    } else if (fraudFile) {
      addAddressRole(addr, "fraud_suspect");
    }

    if (whitelistFile) {
      addAddressRole(addr, "whitelisted");
    }

    let type = normalizeType(rawType);
    const fromText = inferType(name, obs);
    if (fromText !== "unknown" && fromText !== type) {
      if (type === "unknown" || type === "wallet" || (type === "token" && ["bridge", "wrapper"].includes(fromText))) {
        type = fromText;
      }
    }
    const label = name.slice(0, 100);
    const isContract = inferIsContract(type, label, obs);
    const asset = inferAsset(type, name, obs, rawAsset);

    const existing = getAddress(addr);
    if (existing && existing.is_contract === 1 && !isContract && !whitelisted) {
      log("WARN", "processCsvFile", "Endereço já cadastrado como contrato, pulando importação de wallet", {
        address: addr, existingLabel: existing.label, skippedName: name,
      });
      continue;
    }

    const isCatalogo = fileName.toLowerCase().includes("catalogo") || fileName.toLowerCase().includes("enderecos");

    if (existing && existing.name && existing.name.trim().length > 0 && !isCatalogo && !forceOverwrite && !whitelisted) {
      log("INFO", "processCsvFile", "Endereço já possui nome, preservando identificação existente", {
        address: addr, existingName: existing.name, skippedName: name,
      });
    } else {
      upsertAddress(addr, label || (name ? name.slice(0, 100) : ""), type, isContract, asset);
      if (name) setAddressName(addr, name);
    }

    // Atualizar notas normalmente, mas para whitelisted em fraude.csv limpamos a observação de fraude.
    // whitelist.csv é a fonte de verdade para o motivo da isenção.
    if (forceOverwrite || whitelistFile || (fraudFile && whitelisted)) {
      setNotes(addr, obs);
    } else if (obs) {
      setNotes(addr, obs);
    }

    imported++;
  }

  log("OK", "processCsvFile", "CSV importado", { file: fileName, imported });
  return { file: fileName, imported, columns };
}

export function importAllCsvs(dataDir: string, whitelist?: WhitelistService): ImportResult[] {
  getDB();

  if (!fs.existsSync(dataDir)) {
    log("WARN", "importAllCsvs", "Diretório data/ não encontrado", { dir: dataDir });
    return [];
  }

  let effectiveWhitelist = whitelist;
  if (!effectiveWhitelist) {
    const whitelistPath = path.join(dataDir, "whitelist.csv");
    effectiveWhitelist = new WhitelistService(whitelistPath);
    effectiveWhitelist.load();
    log("INFO", "importAllCsvs", "Whitelist carregada", { entries: effectiveWhitelist.size(), path: whitelistPath });
  }

  const csvFiles = fs.readdirSync(dataDir)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .map((f) => path.join(dataDir, f))
    .sort((a, b) => {
      const an = path.basename(a).toLowerCase();
      const bn = path.basename(b).toLowerCase();
      const aCatalogo = an.includes("catalogo") || an.includes("enderecos") || an.includes("enderecos");
      const bCatalogo = bn.includes("catalogo") || bn.includes("enderecos") || bn.includes("enderecos");
      if (aCatalogo && !bCatalogo) return -1;
      if (!aCatalogo && bCatalogo) return 1;
      return an.localeCompare(bn);
    });

  if (csvFiles.length === 0) {
    log("INFO", "importAllCsvs", "Nenhum arquivo CSV encontrado em data/");
    return [];
  }

  const results: ImportResult[] = [];
  let skippedCount = 0;

  for (const csvPath of csvFiles) {
    const fileName = path.basename(csvPath);
    const stat = fs.statSync(csvPath);
    const fileMtime = stat.mtime.toISOString();
    const lastImport = getCsvImportTime(fileName);

    if (lastImport && fileMtime <= lastImport) {
      log("INFO", "importAllCsvs", "CSV sem alterações desde última importação, pulando", {
        file: fileName,
        lastImport,
        fileMtime,
      });
      skippedCount++;
      results.push({ file: fileName, imported: 0, columns: { nameCol: -1, addressCol: -1, obsCol: -1, typeCol: -1, assetCol: -1 } });
      continue;
    }

    try {
      const result = processCsvFile(csvPath, true, effectiveWhitelist);
      results.push(result);
      setCsvImportTime(fileName, fileMtime);
    } catch (err) {
      log("ERROR", "importAllCsvs", "Erro ao processar CSV", { file: fileName, error: (err as Error).message });
    }
  }

  const totalImported = results.reduce((s, r) => s + r.imported, 0);
  log("OK", "importAllCsvs", "Importação de CSVs concluída", {
    totalImported,
    fileCount: csvFiles.length,
    skipped: skippedCount,
    files: results.map((r) => ({ file: r.file, imported: r.imported })),
  });

  return results;
}
