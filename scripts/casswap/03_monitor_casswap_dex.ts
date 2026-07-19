import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { ethers } from "ethers";
import React from "react";
import { getNetworkInfo, requireEnv } from "../utils/deploy_helpers";

const CASSWAP_ABI = [
  "function getRatio() view returns (uint256 numerator, uint256 denominator)",
  "function getCASBalance() view returns (uint256)",
  "function getPOLBalance() view returns (uint256)",
];

const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const WPOL_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const TARGET_CAS_PER_POL = 2.0;
const FALLBACK_RPC = "https://polygon.drpc.org";

interface DexPair {
  name: string;
  address: string;
}

interface BalanceSnapshot {
  address: string;
  pol: string;
  cas: string;
  polDelta?: string;
  casDelta?: string;
}

interface DexData {
  name: string;
  address: string;
  token: string;
  casReserve: string;
  polReserve: string;
  price: number;
  isWPOL: boolean;
  deviationBps: number;
  casDelta?: string;
  polDelta?: string;
}

interface TransferEvent {
  from: string;
  to: string;
  value: string;
  blockNumber: number;
  txHash: string;
}

interface AggregatorData {
  dexScreenerPairs: number;
  coinGeckoUsd: number | null;
}

interface State {
  timestamp: string;
  blockNumber: number;
  casswap: {
    ratio: number;
    casReserve: string;
    polReserve: string;
    casDelta?: string;
    polDelta?: string;
  };
  dexes: DexData[];
  balances: {
    deployer?: BalanceSnapshot;
    infrastructureFund?: BalanceSnapshot;
  };
  transfers: TransferEvent[];
  aggregator: AggregatorData;
}

function logToFile(level: string, message: string, params?: unknown): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/casswap/03_monitor_casswap_dex.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  const line = `[${ts}] [${file}:poll] ${level} ${message}${extra}\n`;
  fs.appendFileSync(path.join("logs", "casswap-price.log"), line);
}

function consoleLog(level: string, message: string, params?: unknown): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/casswap/03_monitor_casswap_dex.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:poll] ${level} ${message}${extra}`);
}

function getProvider(): ethers.JsonRpcProvider {
  const rpc =
    process.env.POLYGON_RPC_URL ??
    (process.env.ANKR_API_KEY ? `https://rpc.ankr.com/polygon/${process.env.ANKR_API_KEY}` : FALLBACK_RPC);
  return new ethers.JsonRpcProvider(rpc);
}

function deriveDeployerAddress(): string {
  const key = process.env.POLYGON_PRIVATE_KEY ?? "";
  if (!key) return "";
  const normalized = key.startsWith("0x") ? key : `0x${key}`;
  try {
    return ethers.computeAddress(normalized);
  } catch {
    return "";
  }
}

function parseMode(): "console" | "dashboard" | "tui" {
  const args = process.argv.slice(2);
  if (
    args.includes("--dashboard") ||
    args.includes("--dashborad") ||
    process.env.MONITOR_MODE === "dashboard"
  ) {
    return "dashboard";
  }
  if (args.includes("--tui") || process.env.MONITOR_MODE === "tui") {
    return "tui";
  }
  return "console";
}

function deltaStr(current: bigint, previous: bigint | null): string | undefined {
  if (previous == null) return undefined;
  const diff = current - previous;
  const sign = diff >= 0n ? "+" : "";
  return `${sign}${ethers.formatEther(diff)}`;
}

async function fetchDexScreener(casAddress: string): Promise<Record<string, unknown>[]> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${casAddress}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { pairs?: any[] };
    return data.pairs ?? [];
  } catch (err: any) {
    return [];
  }
}

async function fetchCoinGecko(casAddress: string): Promise<number | null> {
  const url = `https://api.coingecko.com/api/v3/coins/polygon-pos/contract/${casAddress}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as any;
    return data?.market_data?.current_price?.usd ?? null;
  } catch (err: any) {
    return null;
  }
}

async function fetchTokenMovements(
  casToken: ethers.Contract,
  provider: ethers.Provider,
  previous: State | null,
): Promise<TransferEvent[]> {
  try {
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = previous
      ? Math.max(previous.blockNumber, currentBlock - 2000)
      : Math.max(0, currentBlock - 200);
    if (fromBlock > currentBlock) return [];
    const logs = (await casToken.queryFilter("Transfer", fromBlock, currentBlock)) as any[];
    const events: TransferEvent[] = logs
      .map((log) => {
        const args = log.args;
        if (!args || !args.from) return null as any;
        return {
          from: args.from,
          to: args.to,
          value: ethers.formatEther(args.value),
          blockNumber: Number(log.blockNumber ?? 0),
          txHash: log.transactionHash ?? "",
        };
      })
      .filter(Boolean);
    return events.slice(-20).reverse();
  } catch (err: any) {
    return [];
  }
}

async function fetchState(
  provider: ethers.Provider,
  casswap: ethers.Contract,
  casToken: ethers.Contract,
  casTokenAddress: string,
  pairs: DexPair[],
  deployerAddress: string,
  infraAddress: string,
  previous: State | null,
): Promise<State> {
  const currentBlock = await provider.getBlockNumber();

  const [ratioNum, ratioDen] = await casswap.getRatio();
  const casRes = await casswap.getCASBalance();
  const polRes = await casswap.getPOLBalance();

  const prevCasswap = previous?.casswap;
  const casswapState = {
    ratio: Number(ratioNum) / Number(ratioDen),
    casReserve: ethers.formatEther(casRes),
    polReserve: ethers.formatEther(polRes),
    casDelta: deltaStr(casRes, prevCasswap ? ethers.parseEther(prevCasswap.casReserve) : null),
    polDelta: deltaStr(polRes, prevCasswap ? ethers.parseEther(prevCasswap.polReserve) : null),
  };

  const dexes: DexData[] = [];
  for (const { name, address } of pairs) {
    try {
      const pair = new ethers.Contract(address, PAIR_ABI, provider);
      const [r0, r1] = await pair.getReserves();
      const t0 = (await pair.token0()).toLowerCase();
      const t1 = (await pair.token1()).toLowerCase();
      const isCas0 = t0 === casTokenAddress.toLowerCase();
      const casReserve = isCas0 ? r0 : r1;
      const otherReserve = isCas0 ? r1 : r0;
      const otherToken = isCas0 ? t1 : t0;
      const isWPOL = otherToken === WPOL_ADDRESS.toLowerCase();
      const price = Number(casReserve) / Number(otherReserve);
      const deviation = Math.abs(price - TARGET_CAS_PER_POL) / TARGET_CAS_PER_POL;

      const prevDex = previous?.dexes.find((d) => d.address === address);
      dexes.push({
        name,
        address,
        token: otherToken,
        casReserve: ethers.formatEther(casReserve),
        polReserve: ethers.formatEther(otherReserve),
        price,
        isWPOL,
        deviationBps: Math.round(deviation * 10_000),
        casDelta: deltaStr(casReserve, prevDex ? ethers.parseEther(prevDex.casReserve) : null),
        polDelta: deltaStr(otherReserve, prevDex ? ethers.parseEther(prevDex.polReserve) : null),
      });
    } catch (err: any) {
      dexes.push({
        name,
        address,
        token: "",
        casReserve: "0",
        polReserve: "0",
        price: 0,
        isWPOL: false,
        deviationBps: 0,
      });
    }
  }

  const deployerPol = deployerAddress ? await provider.getBalance(deployerAddress) : 0n;
  const deployerCas = deployerAddress ? await casToken.balanceOf(deployerAddress) : 0n;
  const infraPol = infraAddress ? await provider.getBalance(infraAddress) : 0n;
  const infraCas = infraAddress ? await casToken.balanceOf(infraAddress) : 0n;

  const balances: State["balances"] = {};
  if (deployerAddress) {
    const prev = previous?.balances?.deployer;
    balances.deployer = {
      address: deployerAddress,
      pol: ethers.formatEther(deployerPol),
      cas: ethers.formatEther(deployerCas),
      polDelta: deltaStr(deployerPol, prev ? ethers.parseEther(prev.pol) : null),
      casDelta: deltaStr(deployerCas, prev ? ethers.parseEther(prev.cas) : null),
    };
  }
  if (infraAddress) {
    const prev = previous?.balances?.infrastructureFund;
    balances.infrastructureFund = {
      address: infraAddress,
      pol: ethers.formatEther(infraPol),
      cas: ethers.formatEther(infraCas),
      polDelta: deltaStr(infraPol, prev ? ethers.parseEther(prev.pol) : null),
      casDelta: deltaStr(infraCas, prev ? ethers.parseEther(prev.cas) : null),
    };
  }

  const transfers = await fetchTokenMovements(casToken, provider, previous);

  const aggregator: AggregatorData = {
    dexScreenerPairs: (await fetchDexScreener(casTokenAddress)).length,
    coinGeckoUsd: await fetchCoinGecko(casTokenAddress),
  };

  return {
    timestamp: new Date().toISOString(),
    blockNumber: currentBlock,
    casswap: casswapState,
    dexes,
    balances,
    transfers,
    aggregator,
  };
}

function renderConsole(state: State): void {
  consoleLog("INFO", "CASSwap snapshot", {
    ratio: state.casswap.ratio.toFixed(4),
    casReserve: state.casswap.casReserve,
    polReserve: state.casswap.polReserve,
    casDelta: state.casswap.casDelta,
    polDelta: state.casswap.polDelta,
  });

  for (const dex of state.dexes) {
    if (dex.deviationBps > 0) {
      consoleLog("ALERT", `${dex.name} fora do ratio alvo`, {
        price: dex.price.toFixed(6),
        target: TARGET_CAS_PER_POL,
        deviationBps: dex.deviationBps,
        isWPOL: dex.isWPOL,
      });
    }
  }

  consoleLog("INFO", "Balances", state.balances);
  consoleLog("INFO", "Transfers", { count: state.transfers.length, latest: state.transfers.slice(0, 5) });
  consoleLog("INFO", "Aggregator snapshot", state.aggregator);
}

function startDashboard(latest: { state: State | null }): void {
  const port = Number(process.env.DASHBOARD_PORT ?? "3456");
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CAS Monitor Dashboard</title>
  <style>
    :root { --bg: #0f172a; --card: #1e293b; --text: #e2e8f0; --muted: #94a3b8; --up: #22c55e; --down: #ef4444; --accent: #38bdf8; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); padding: 20px; }
    h1 { margin: 0 0 20px; font-size: 1.6rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    .card { background: var(--card); border-radius: 12px; padding: 16px; }
    .card h2 { margin: 0 0 12px; font-size: 1rem; color: var(--accent); }
    .row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .row:last-child { border-bottom: none; }
    .muted { color: var(--muted); }
    .up { color: var(--up); }
    .down { color: var(--down); }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    th { color: var(--muted); font-weight: 600; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    #error { color: var(--down); margin-bottom: 12px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; background: rgba(56,189,248,0.15); color: var(--accent); font-size: 0.75rem; }
  </style>
</head>
<body>
  <h1>CAS Monitor Dashboard <span class="badge" id="updated">carregando...</span></h1>
  <div id="error"></div>
  <div class="grid">
    <div class="card">
      <h2>CASSwap</h2>
      <div id="casswap"></div>
    </div>
    <div class="card">
      <h2>Salvos</h2>
      <div id="balances"></div>
    </div>
    <div class="card">
      <h2>Agregadores</h2>
      <div id="aggregator"></div>
    </div>
    <div class="card" style="grid-column: 1 / -1;">
      <h2>DEXs</h2>
      <div id="dexes"></div>
    </div>
    <div class="card" style="grid-column: 1 / -1;">
      <h2>Últimas movimentações CAS</h2>
      <div id="transfers"></div>
    </div>
  </div>
  <script>
    const target = 2.0;
    function fmt(n) {
      try { return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 6 }); } catch { return n; }
    }
    function deltaClass(v) {
      if (!v) return '';
      return v.startsWith('+') ? 'up' : 'down';
    }
    function row(label, value, extra) {
      return '<div class="row"><span class="muted">' + label + '</span><span>' + value + (extra ? ' <small class="' + deltaClass(extra) + '">(' + extra + ')</small>' : '') + '</span></div>';
    }
    function renderCasswap(c) {
      const div = document.getElementById('casswap');
      div.innerHTML =
        row('Ratio', '1 POL = ' + fmt(c.ratio) + ' CAS') +
        row('Reserva CAS', fmt(c.casReserve) + ' CAS', c.casDelta) +
        row('Reserva POL', fmt(c.polReserve) + ' POL', c.polDelta);
    }
    function renderBalances(b) {
      const div = document.getElementById('balances');
      let html = '';
      if (b.deployer) html += row('Deployer', fmt(b.deployer.pol) + ' POL / ' + fmt(b.deployer.cas) + ' CAS', b.deployer.polDelta);
      if (b.infrastructureFund) html += row('InfrastructureFund', fmt(b.infrastructureFund.pol) + ' POL / ' + fmt(b.infrastructureFund.cas) + ' CAS', b.infrastructureFund.polDelta);
      div.innerHTML = html || '<span class="muted">Endereços não configurados</span>';
    }
    function renderDexes(dexes) {
      const div = document.getElementById('dexes');
      if (!dexes.length) { div.innerHTML = '<span class="muted">Nenhum par configurado</span>'; return; }
      let html = '<table><tr><th>DEX</th><th>1 POL = CAS</th><th>Desvio (bps)</th><th>Reserva CAS</th><th>Reserva POL/OTHER</th><th>Delta CAS</th><th>Delta POL</th></tr>';
      for (const d of dexes) {
        const price = d.isWPOL ? fmt(d.price) : fmt(d.price) + ' (OTHER)';
        const deviation = d.isWPOL ? fmt(d.deviationBps) : '-';
        html += '<tr><td>' + d.name + '</td><td>' + price + '</td><td>' + deviation + '</td><td class="mono">' + fmt(d.casReserve) + '</td><td class="mono">' + fmt(d.polReserve) + '</td><td class="' + deltaClass(d.casDelta) + '">' + (d.casDelta || '-') + '</td><td class="' + deltaClass(d.polDelta) + '">' + (d.polDelta || '-') + '</td></tr>';
      }
      html += '</table>';
      div.innerHTML = html;
    }
    function renderTransfers(list) {
      const div = document.getElementById('transfers');
      if (!list.length) { div.innerHTML = '<span class="muted">Nenhuma movimentação no período</span>'; return; }
      let html = '<table><tr><th>Bloco</th><th>De</th><th>Para</th><th>Valor CAS</th><th>Tx</th></tr>';
      for (const t of list) {
        const txShort = t.txHash ? t.txHash.slice(0, 10) + '...' + t.txHash.slice(-8) : '-';
        html += '<tr><td>' + t.blockNumber + '</td><td class="mono">' + t.from.slice(0, 8) + '...' + t.from.slice(-6) + '</td><td class="mono">' + t.to.slice(0, 8) + '...' + t.to.slice(-6) + '</td><td>' + fmt(t.value) + '</td><td class="mono"><a href="https://polygonscan.com/tx/' + t.txHash + '" target="_blank" style="color:var(--accent)">' + txShort + '</a></td></tr>';
      }
      html += '</table>';
      div.innerHTML = html;
    }
    function renderAggregator(a) {
      const div = document.getElementById('aggregator');
      div.innerHTML =
        row('DEX Screener pares', a.dexScreenerPairs) +
        row('CoinGecko USD', a.coinGeckoUsd != null ? '$' + fmt(a.coinGeckoUsd) : 'não listado');
    }
    async function fetchData() {
      try {
        const res = await fetch('/api/state');
        const data = await res.json();
        document.getElementById('error').innerText = '';
        renderCasswap(data.casswap);
        renderBalances(data.balances);
        renderDexes(data.dexes);
        renderTransfers(data.transfers);
        renderAggregator(data.aggregator);
        document.getElementById('updated').innerText = new Date(data.timestamp).toLocaleTimeString('pt-BR');
      } catch (e) {
        document.getElementById('error').innerText = 'Erro: ' + e.message;
      }
    }
    fetchData();
    setInterval(fetchData, 5000);
  </script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    if (req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(latest.state ?? {}));
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    }
  });

  server.listen(port, () => {
    console.log(`Dashboard disponível em http://localhost:${port}`);
    console.log(`API state: http://localhost:${port}/api/state`);
  });
}

async function startTui(
  refresh: () => Promise<State>,
  pollInterval: number,
): Promise<void> {
  const ink: any = await import("ink");
  const { Box, Text, useInput, Spacer, render } = ink;

  function App() {
    const [state, setState] = React.useState<State | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
      let mounted = true;
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        try {
          const s = await refresh();
          if (mounted) setState(s);
        } catch (err: any) {
          if (mounted) setError(err.message);
        } finally {
          running = false;
        }
      };
      tick();
      const id = setInterval(tick, pollInterval);
      return () => {
        mounted = false;
        clearInterval(id);
      };
    }, [pollInterval]);

    useInput((input: string, key: any) => {
      if (input === "q" || (key.ctrl && input === "c")) {
        process.exit(0);
      }
    });

    if (error) {
      return React.createElement(Text, { color: "red" }, `Erro: ${error}`);
    }
    if (!state) {
      return React.createElement(Text, null, "Carregando...");
    }

    const header = React.createElement(
      Box,
      { borderStyle: "round", borderColor: "cyan", padding: 1, marginBottom: 1 },
      React.createElement(Text, { bold: true, color: "cyan" }, "CAS Monitor - TUI "),
      React.createElement(Text, { color: "gray" }, `Bloco ${state.blockNumber} | ${new Date(state.timestamp).toLocaleTimeString("pt-BR")}`),
    );

    const casswapCard = React.createElement(
      Box,
      { borderStyle: "single", padding: 1, flexDirection: "column", width: "50%" },
      React.createElement(Text, { bold: true, color: "cyan", underline: true }, "CASSwap"),
      React.createElement(Text, null, `Ratio: 1 POL = ${state.casswap.ratio.toFixed(4)} CAS`),
      React.createElement(Text, null, `CAS reserve: ${state.casswap.casReserve} ${state.casswap.casDelta ? `(${state.casswap.casDelta})` : ""}`),
      React.createElement(Text, null, `POL reserve: ${state.casswap.polReserve} ${state.casswap.polDelta ? `(${state.casswap.polDelta})` : ""}`),
    );

    const balances = [];
    if (state.balances.deployer) {
      balances.push(React.createElement(Text, { key: "dep" }, `Deployer: ${state.balances.deployer.pol} POL / ${state.balances.deployer.cas} CAS`));
    }
    if (state.balances.infrastructureFund) {
      balances.push(React.createElement(Text, { key: "infra" }, `InfraFund: ${state.balances.infrastructureFund.pol} POL / ${state.balances.infrastructureFund.cas} CAS`));
    }
    const balanceCard = React.createElement(
      Box,
      { borderStyle: "single", padding: 1, flexDirection: "column", width: "50%" },
      React.createElement(Text, { bold: true, color: "cyan", underline: true }, "Saldos"),
      balances.length ? balances : React.createElement(Text, { color: "gray" }, "Não configurados"),
    );

    const dexRows = state.dexes.map((dex: DexData) =>
      React.createElement(Text, { key: dex.name, color: dex.isWPOL && dex.deviationBps > 500 ? "red" : "white" },
        `${dex.name.padEnd(12)} 1 ${dex.isWPOL ? "POL" : "OTHER"} = ${dex.price.toFixed(6)} CAS  desvio ${dex.deviationBps} bps`)
    );
    const dexCard = React.createElement(
      Box,
      { borderStyle: "single", padding: 1, flexDirection: "column", marginTop: 1 },
      React.createElement(Text, { bold: true, color: "cyan", underline: true }, "DEXs"),
      ...dexRows,
    );

    const transferRows = state.transfers.slice(0, 8).map((t: TransferEvent, i: number) =>
      React.createElement(Text, { key: i, color: "gray" },
        `#${t.blockNumber} ${t.from.slice(0, 8)}... -> ${t.to.slice(0, 8)}...  ${Number(t.value).toFixed(4)} CAS`)
    );
    const transfersCard = React.createElement(
      Box,
      { borderStyle: "single", padding: 1, flexDirection: "column", marginTop: 1 },
      React.createElement(Text, { bold: true, color: "cyan", underline: true }, "Movimentações CAS recentes"),
      transferRows.length ? transferRows : React.createElement(Text, { color: "gray" }, "Nenhuma"),
    );

    const aggCard = React.createElement(
      Box,
      { borderStyle: "single", padding: 1, flexDirection: "column", marginTop: 1 },
      React.createElement(Text, { bold: true, color: "cyan", underline: true }, "Agregadores"),
      React.createElement(Text, null, `DEX Screener pares: ${state.aggregator.dexScreenerPairs}`),
      React.createElement(Text, null, `CoinGecko USD: ${state.aggregator.coinGeckoUsd ? state.aggregator.coinGeckoUsd.toString() : "não listado"}`),
    );

    const footer = React.createElement(Text, { color: "gray" }, "Pressione 'q' para sair");

    return React.createElement(
      Box,
      { flexDirection: "column", padding: 1 },
      header,
      React.createElement(Box, { flexDirection: "row" }, casswapCard, balanceCard),
      dexCard,
      transfersCard,
      aggCard,
      React.createElement(Spacer),
      footer,
    );
  }

  render(React.createElement(App));
}

async function main(): Promise<void> {
  fs.mkdirSync("logs", { recursive: true });
  const mode = parseMode();

  console.log(`\n====================================================`);
  console.log(`  Monitor CASSwap / DEX / Agregadores`);
  console.log(`  Modo: ${mode}`);
  console.log(`====================================================\n`);

  const provider = getProvider();
  const env = requireEnv(["CAS_SWAP_ADDRESS", "CAS_TOKEN_ADDRESS"]);
  const casswap = new ethers.Contract(env.CAS_SWAP_ADDRESS, CASSWAP_ABI, provider);
  const casToken = new ethers.Contract(env.CAS_TOKEN_ADDRESS, ERC20_ABI, provider);

  const deployerAddress = process.env.DEPLOYER_ADDRESS ?? deriveDeployerAddress();
  const infraAddress = process.env.INFRASTRUCTURE_FUND_ADDRESS ?? "";

  const pairs: DexPair[] = [
    { name: "QuickSwap", address: process.env.QUICKSWAP_LP_TOKEN_ADDRESS ?? "" },
    { name: "SushiSwap", address: process.env.SUSHISWAP_LP_TOKEN_ADDRESS ?? "" },
    { name: "ApeSwap", address: process.env.APESWAP_LP_TOKEN_ADDRESS ?? "" },
    { name: "Dfyn", address: process.env.DFYN_LP_TOKEN_ADDRESS ?? "" },
  ].filter((p) => p.address !== "" && ethers.isAddress(p.address));

  const pollInterval = Number(process.env.POLL_INTERVAL_MS ?? "30000");
  const deviationBps = Number(process.env.DEVIATION_BPS ?? "500");

  let previousState: State | null = null;
  let latestState: State | null = null;

  const refresh = async (): Promise<State> => {
    const state = await fetchState(
      provider,
      casswap,
      casToken,
      env.CAS_TOKEN_ADDRESS,
      pairs,
      deployerAddress,
      infraAddress,
      previousState,
    );
    previousState = state;
    latestState = state;
    return state;
  };

  if (mode === "dashboard") {
    const holder: { state: State | null } = { state: null };
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        holder.state = await refresh();
        logToFile("INFO", "Dashboard update", { blockNumber: holder.state.blockNumber });
      } catch (err: any) {
        consoleLog("ERROR", "Dashboard poll failed", { error: err.message });
      } finally {
        running = false;
      }
    };
    await tick();
    setInterval(tick, pollInterval);
    startDashboard(holder);
  } else if (mode === "tui") {
    await startTui(refresh, pollInterval);
  } else {
    await refresh();
    renderConsole(latestState!);
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const state = await refresh();
        renderConsole(state);
      } catch (err: any) {
        consoleLog("ERROR", "Console poll failed", { error: err.message });
      } finally {
        running = false;
      }
    };
    setInterval(tick, pollInterval);

    process.on("SIGINT", () => {
      console.log("\nMonitor encerrado pelo usuario.");
      process.exit(0);
    });
  }
}

main().catch((err) => {
  consoleLog("ERROR", "Monitor failed", { error: err.message });
  console.error(err);
  process.exit(1);
});
