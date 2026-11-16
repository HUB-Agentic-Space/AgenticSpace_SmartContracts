import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { syncTransfers } from "../../scripts/utils/cas_sync";
import {
  closeDB,
  getTransactionCount,
  getAllTransactionsFromDB,
  insertTransaction,
} from "../../scripts/utils/cas_database";

/**
 * Testes do fallback eth_getLogs via RPC de cas_sync.syncTransfers.
 *
 * Cenário de regressão: o índice tokentx do scan (Etherscan V2) fica
 * parado e devolve "No transactions found" enquanto a chain já possui
 * eventos Transfer novos — o sync deve cobrir a lacuna lendo os logs
 * direto do RPC, senão os saldos do dashboard congelam.
 *
 * Toda a rede é stubada via globalThis.fetch — nenhuma chamada real sai.
 * O banco é um SQLite temporário via CAS_DB_PATH.
 */

const TOKEN = "0x5151A34EaC7bA08cd6B540b32cD30316218A2287";
const FAKE_RPC = "https://fake-rpc.local";
const PUBLIC_RPC = "https://polygon-bor-rpc.publicnode.com";
const ZERO = "0x0000000000000000000000000000000000000000";
const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

let fetchCalls: { url: string; init?: RequestInit }[] = [];
let stubbedFetch: FetchStub = async () => new Response("{}", { status: 200 });

const realFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
let tmpDir = "";

function installFetchStub(fn: FetchStub): void {
  fetchCalls = [];
  stubbedFetch = fn;
  // Reatribui o global a cada instalação: outros arquivos de teste também
  // stubam globalThis.fetch e a ordem dos hooks entre arquivos não é
  // garantida — sem isso o stub de outro arquivo fica ativo neste suite.
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    fetchCalls.push({ url: u, init });
    return stubbedFetch(url, init);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function padTopic(addr: string): string {
  return `0x${addr.replace(/^0x/, "").padStart(64, "0")}`;
}

function transferLog(block: number, txHash: string, from: string, to: string, valueWei: bigint): unknown {
  return {
    address: TOKEN,
    transactionHash: txHash,
    blockNumber: `0x${block.toString(16)}`,
    logIndex: "0x0",
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      padTopic(from),
      padTopic(to),
    ],
    data: `0x${valueWei.toString(16)}`,
  };
}

interface RpcStubOpts {
  tip: number;
  logs: unknown[];
  maxSpan?: number;
  failHosts?: Set<string>;
}

/** Monta um stub de fetch: scan sempre vazio; RPC responde conforme opts. */
function rpcAwareStub(opts: RpcStubOpts): FetchStub {
  return async (url, init) => {
    const u = String(url);
    if (u.includes("etherscan.io")) {
      return jsonResponse({ status: "0", message: "No transactions found", result: [] });
    }
    if (opts.failHosts?.has(new URL(u).hostname)) {
      throw new TypeError("fetch failed");
    }
    const body = JSON.parse(String(init?.body));
    const answer = (method: string, params: any[]): unknown => {
      if (method === "eth_blockNumber") return `0x${opts.tip.toString(16)}`;
      if (method === "eth_getLogs") {
        const filter = params[0];
        const span = parseInt(filter.toBlock, 16) - parseInt(filter.fromBlock, 16) + 1;
        if (opts.maxSpan && span > opts.maxSpan) {
          throw { code: 35, message: `ranges over ${opts.maxSpan} blocks are not supported` };
        }
        return opts.logs;
      }
      if (method === "eth_getBlockByNumber") {
        return { number: params[0], timestamp: `0x${(1_700_000_000).toString(16)}` };
      }
      throw new Error(`método RPC inesperado: ${method}`);
    };
    try {
      if (Array.isArray(body)) {
        return jsonResponse(body.map((req) => ({ jsonrpc: "2.0", id: req.id, result: answer(req.method, req.params) })));
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: answer(body.method, body.params) });
    } catch (err) {
      const e = err as { code?: number; message?: string };
      if (Array.isArray(body)) {
        return jsonResponse(body.map((req) => ({ jsonrpc: "2.0", id: req.id, error: { code: e.code ?? -32000, message: e.message ?? "err" } })));
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: e.code ?? -32000, message: e.message ?? "err" } });
    }
  };
}

function seedTx(block: number, txHash: string): void {
  insertTransaction({
    tx_hash: txHash,
    block_number: block,
    timestamp: 1_600_000_000,
    from_address: ZERO,
    to_address: WALLET_A,
    value: "1000",
    is_mint: 1,
    is_burn: 0,
    label: "",
    description: "",
  });
}

before(function () {
  installFetchStub(stubbedFetch);
});

beforeEach(function () {
  closeDB();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-sync-test-"));
  setEnv("CAS_DB_PATH", path.join(tmpDir, "test.db"));
  setEnv("POLYGON_RPC_URL", FAKE_RPC);
  installFetchStub(stubbedFetch);
});

afterEach(function () {
  closeDB();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

after(function () {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("cas_sync — fallback eth_getLogs quando o índice do scan está parado", function () {
  this.timeout(60_000);

  it("insere transfers recentes que o scan não enxerga", async () => {
    seedTx(100, "0xaaa");
    installFetchStub(rpcAwareStub({
      tip: 105,
      logs: [
        transferLog(103, "0xbbb", WALLET_A, WALLET_B, 500n),
        transferLog(104, "0xccc", WALLET_B, WALLET_A, 250n),
      ],
    }));

    const transfers = await syncTransfers(TOKEN);

    expect(getTransactionCount()).to.equal(3);
    const txs = getAllTransactionsFromDB();
    const rpcTx = txs.find((t) => t.tx_hash === "0xbbb");
    expect(rpcTx).to.exist;
    expect(rpcTx!.from_address).to.equal(WALLET_A);
    expect(rpcTx!.to_address).to.equal(WALLET_B);
    expect(rpcTx!.value).to.equal("500");
    expect(rpcTx!.timestamp).to.equal(1_700_000_000);
    expect(transfers.map((t) => t.hash)).to.include("0xccc");
  });

  it("deduplica logs já presentes no banco", async () => {
    seedTx(100, "0xaaa");
    insertTransaction({
      tx_hash: "0xbbb",
      block_number: 103,
      timestamp: 1_600_000_100,
      from_address: WALLET_A,
      to_address: WALLET_B,
      value: "500",
      is_mint: 0,
      is_burn: 0,
      label: "",
      description: "",
    });
    installFetchStub(rpcAwareStub({
      tip: 105,
      logs: [transferLog(103, "0xbbb", WALLET_A, WALLET_B, 500n)],
    }));

    await syncTransfers(TOKEN);
    expect(getTransactionCount()).to.equal(2, "log já conhecido não deve duplicar");
  });

  it("não chama eth_getLogs quando o banco já cobre a ponta da chain", async () => {
    seedTx(105, "0xaaa");
    installFetchStub(rpcAwareStub({ tip: 105, logs: [] }));

    await syncTransfers(TOKEN);

    const getLogsCalls = fetchCalls.filter((c) => {
      const body = String(c.init?.body ?? "");
      return body.includes("eth_getLogs");
    });
    expect(getLogsCalls).to.have.length(0);
  });

  it("rotaciona para o próximo RPC quando o endpoint configurado falha", async () => {
    seedTx(100, "0xaaa");
    installFetchStub(rpcAwareStub({
      tip: 103,
      logs: [transferLog(102, "0xbbb", WALLET_A, WALLET_B, 10n)],
      failHosts: new Set([new URL(FAKE_RPC).hostname]),
    }));

    await syncTransfers(TOKEN);

    expect(getTransactionCount()).to.equal(2);
    const rpcHosts = fetchCalls
      .filter((c) => !c.url.includes("etherscan.io"))
      .map((c) => new URL(c.url).hostname);
    expect(rpcHosts).to.include(new URL(FAKE_RPC).hostname);
    expect(rpcHosts).to.include(new URL(PUBLIC_RPC).hostname);
  });

  it("reduz o chunk quando o RPC rejeita ranges grandes", async () => {
    seedTx(100, "0xaaa");
    installFetchStub(rpcAwareStub({
      tip: 104_900,
      maxSpan: 2_000,
      logs: [transferLog(104_900, "0xbbb", WALLET_A, WALLET_B, 10n)],
    }));

    await syncTransfers(TOKEN);

    const spans = fetchCalls
      .map((c) => {
        const body = String(c.init?.body ?? "");
        if (!body.includes("eth_getLogs")) return null;
        const params = JSON.parse(body).params[0];
        return parseInt(params.toBlock, 16) - parseInt(params.fromBlock, 16) + 1;
      })
      .filter((s): s is number => s !== null);
    // Spans incluem as tentativas rejeitadas (5000, 2500); a última
    // chamada — aceita pelo RPC — deve caber no limite do provedor.
    expect(spans[spans.length - 1]).to.be.lte(2_000, "chunk deve ser reduzido até o RPC aceitar");
    expect(getTransactionCount()).to.be.gte(1);
  });
});
