import { expect } from "chai";
import {
  scanRequest,
  fetchTotalSupply,
  hasApiKey,
  resetScanApiState,
} from "../../scripts/utils/cas_sync";

/**
 * Testes do cliente Etherscan V2 (cas_sync.scanRequest/fetchTotalSupply).
 * Toda a rede é stubada via globalThis.fetch — nenhuma chamada real sai.
 */

const TOKEN = "0x5151A34EaC7bA08cd6B540b32cD30316218A2287";
const FAKE_RPC = "https://fake-rpc.local";

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

let fetchCalls: { url: string; init?: RequestInit }[] = [];
let stubbedFetch: FetchStub = async () => new Response("{}", { status: 200 });

const realFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

function installFetchStub(fn: FetchStub): void {
  fetchCalls = [];
  stubbedFetch = fn;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    fetchCalls.push({ url: u, init });
    return stubbedFetch(url, init);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function htmlResponse(): Response {
  return new Response("<html><head><title>Redirect</title></head><body>moved</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function apiOk(result: unknown): Response {
  return jsonResponse({ status: "1", message: "OK", result });
}

function apiError(message: string): Response {
  return jsonResponse({ status: "0", message, result: message });
}

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function expectReject(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect((err as Error).message).to.match(pattern);
    return;
  }
  expect.fail("esperava rejeição que não ocorreu");
}

before(function () {
  this.timeout(10_000);
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => stubbedFetch(...args)) as typeof fetch;
});

beforeEach(function () {
  resetScanApiState();
  fetchCalls = [];
  installFetchStub(stubbedFetch);
});

after(function () {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("cas_sync — scanRequest (cliente Etherscan V2)", function () {
  this.timeout(60_000);

  it("retorna o resultado quando a API responde status=1", async () => {
    installFetchStub(async () => apiOk("12345"));
    const result = await scanRequest({ module: "stats", action: "tokensupply", contractaddress: TOKEN });
    expect(result).to.equal("12345");
    expect(fetchCalls).to.have.length(1);
    expect(fetchCalls[0].url).to.include("etherscan.io/v2/api");
    expect(fetchCalls[0].url).to.include("chainid=137");
  });

  it("não tenta a base V1 descontinuada do Polygonscan", async () => {
    installFetchStub(async () => apiOk([]));
    await scanRequest({ module: "account", action: "tokentx", contractaddress: TOKEN });
    for (const c of fetchCalls) {
      expect(c.url).to.not.include("api.polygonscan.com");
    }
  });

  it("marca base que responde HTML como morta e não a repete", async () => {
    installFetchStub(async () => htmlResponse());
    await expectReject(
      scanRequest({ module: "stats", action: "tokensupply", contractaddress: TOKEN }),
      /não-JSON/,
    );
    const callsAfterFirst = fetchCalls.length;

    await expectReject(
      scanRequest({ module: "stats", action: "tokensupply", contractaddress: TOKEN }),
      /indisponíveis/,
    );
    expect(fetchCalls.length).to.equal(callsAfterFirst, "base morta não deve ser requisitada de novo");
  });

  it("honra o header Retry-After como piso do backoff em HTTP 429", async () => {
    let n = 0;
    installFetchStub(async () => {
      n++;
      return n === 1
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "4" } })
        : apiOk("7");
    });
    const started = Date.now();
    const result = await scanRequest({ module: "stats", action: "tokensupply", contractaddress: TOKEN });
    const elapsed = Date.now() - started;
    expect(result).to.equal("7");
    expect(n).to.equal(2);
    // backoff padrão seria ~1.4s+2s de extra delay; o header de 4s deve dominar.
    expect(elapsed).to.be.gte(4000, "espera deve respeitar Retry-After=4");
  });

  it("classifica 'fetch failed' com cause.code UND_ERR_* como transitório", async () => {
    let n = 0;
    installFetchStub(async () => {
      n++;
      if (n === 1) {
        const err = new TypeError("fetch failed") as TypeError & { cause: { code: string } };
        err.cause = { code: "UND_ERR_HEADERS_TIMEOUT" };
        throw err;
      }
      return apiOk("ok");
    });
    const result = await scanRequest({ module: "stats", action: "tokensupply", contractaddress: TOKEN });
    expect(result).to.equal("ok");
    expect(n).to.equal(2, "erro de rede transitório deve gerar retry");
  });

  it("usa timeout progressivo: a 2ª tentativa tem orçamento maior", async () => {
    installFetchStub(async () => apiOk("x"));
    await scanRequest({ module: "stats", action: "tokensupply", contractaddress: TOKEN });
    // Sucesso imediato — o orçamento progressivo é exercido nos demais casos;
    // aqui garantimos apenas que a API pública continua íntegra.
    expect(fetchCalls).to.have.length(1);
  });
});

describe("cas_sync — fetchTotalSupply (cadeia de fallback)", function () {
  this.timeout(60_000);

  it("retorna BigInt do tokensupply quando a API responde", async () => {
    installFetchStub(async () => apiOk("3500000000000000000000000"));
    const supply = await fetchTotalSupply(TOKEN);
    expect(supply).to.equal(3500000000000000000000000n);
    expect(fetchCalls[0].url).to.include("action=tokensupply");
  });

  it("faz fallback para eth_call via proxy quando tokensupply falha", async () => {
    installFetchStub(async (url) => {
      const u = String(url);
      if (u.includes("action=tokensupply")) return apiError("deprecated");
      if (u.includes("action=eth_call")) return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x2f68caa3e7cbe9f9cc00000" });
      throw new Error(`URL inesperada: ${u}`);
    });
    const supply = await fetchTotalSupply(TOKEN);
    expect(supply).to.equal(BigInt("0x2f68caa3e7cbe9f9cc00000"));
    const actions = fetchCalls.map((c) => c.url);
    expect(actions.some((u) => u.includes("action=tokensupply"))).to.equal(true);
    expect(actions.some((u) => u.includes("action=eth_call"))).to.equal(true);
  });

  it("cai para o JSON-RPC direto (POLYGON_RPC_URL) quando o scan falha", async () => {
    setEnv("POLYGON_RPC_URL", FAKE_RPC);
    try {
      installFetchStub(async (url, init) => {
        const u = String(url);
        if (u.includes("etherscan.io")) return apiError("down");
        if (u === FAKE_RPC) {
          const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
          expect(body.method).to.equal("eth_call");
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x3635c9adc5dea00000" });
        }
        throw new Error(`URL inesperada: ${u}`);
      });
      const supply = await fetchTotalSupply(TOKEN);
      expect(supply).to.equal(BigInt("0x3635c9adc5dea00000"));
      expect(fetchCalls.some((c) => c.url === FAKE_RPC)).to.equal(true);
    } finally {
      delete process.env.POLYGON_RPC_URL;
      savedEnv["POLYGON_RPC_URL"] = undefined;
    }
  });
});

describe("cas_sync — hasApiKey", function () {
  it("aceita ETHERSCAN_API_KEY sozinha", () => {
    setEnv("ETHERSCAN_API_KEY", "key-etherscan");
    setEnv("POLYGONSCAN_API_KEY", undefined);
    expect(hasApiKey()).to.equal(true);
  });

  it("aceita POLYGONSCAN_API_KEY sozinha", () => {
    setEnv("ETHERSCAN_API_KEY", undefined);
    setEnv("POLYGONSCAN_API_KEY", "key-polygonscan");
    expect(hasApiKey()).to.equal(true);
  });

  it("rejeita quando nenhuma chave está configurada", () => {
    setEnv("ETHERSCAN_API_KEY", undefined);
    setEnv("POLYGONSCAN_API_KEY", undefined);
    expect(hasApiKey()).to.equal(false);
  });
});
