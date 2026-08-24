/**
 * 16_add_multi_route_presets.ts
 *
 * Cadastra rotas pré-definidas no MultiRouteSwapFacet do Diamond.
 *
 * Rotas cadastradas:
 *   - dfyn_to_apeswap: CAS → WETH (Dfyn) → WPOL (QuickSwap) → CAS (ApeSwap)
 *   - dfyn_to_quickswap: CAS → WETH (Dfyn) → WPOL (QuickSwap) → CAS (QuickSwap)
 *   - sushiswap_to_apeswap: CAS → WPOL (SushiSwap) → CAS (ApeSwap)
 *
 * Variáveis de ambiente esperadas:
 *   DIAMOND_ADDRESS
 *   RELAYER_PRIVATE_KEY
 *   CAS_TOKEN_ADDRESS
 *   POLYGON_RPC_URL (opcional, fallback para hardhat config)
 */
import "dotenv/config";
import { ethers } from "hardhat";
import { requireEnv } from "../utils/deploy_helpers";

function log(level: string, msg: string, params?: unknown): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [16_add_multi_route_presets] ${level} ${msg}${extra}`);
}

const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

const DFYN_ROUTER = "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429";
const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const APESWAP_ROUTER = "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607";
const SUSHISWAP_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

interface HopDef {
  router: string;
  path: string[];
  useNativeIn: boolean;
  useNativeOut: boolean;
  amountIn: string;
}

const ROUTES: Array<{ name: string; hops: HopDef[] }> = [
  {
    name: "dfyn_to_apeswap",
    hops: [
      {
        router: DFYN_ROUTER,
        path: [process.env.CAS_TOKEN_ADDRESS!, WETH],
        useNativeIn: false,
        useNativeOut: false,
        amountIn: "0",
      },
      {
        router: QUICKSWAP_ROUTER,
        path: [WETH, WPOL],
        useNativeIn: false,
        useNativeOut: false,
        amountIn: "0",
      },
      {
        router: APESWAP_ROUTER,
        path: [WPOL, process.env.CAS_TOKEN_ADDRESS!],
        useNativeIn: true,
        useNativeOut: false,
        amountIn: "0",
      },
    ],
  },
  {
    name: "dfyn_to_quickswap",
    hops: [
      {
        router: DFYN_ROUTER,
        path: [process.env.CAS_TOKEN_ADDRESS!, WETH],
        useNativeIn: false,
        useNativeOut: false,
        amountIn: "0",
      },
      {
        router: QUICKSWAP_ROUTER,
        path: [WETH, WPOL],
        useNativeIn: false,
        useNativeOut: false,
        amountIn: "0",
      },
      {
        router: QUICKSWAP_ROUTER,
        path: [WPOL, process.env.CAS_TOKEN_ADDRESS!],
        useNativeIn: true,
        useNativeOut: false,
        amountIn: "0",
      },
    ],
  },
  {
    name: "sushiswap_to_apeswap",
    hops: [
      {
        router: SUSHISWAP_ROUTER,
        path: [process.env.CAS_TOKEN_ADDRESS!, WPOL],
        useNativeIn: false,
        useNativeOut: true,
        amountIn: "0",
      },
      {
        router: APESWAP_ROUTER,
        path: [WPOL, process.env.CAS_TOKEN_ADDRESS!],
        useNativeIn: true,
        useNativeOut: false,
        amountIn: "0",
      },
    ],
  },
  {
    name: "apeswap_to_dfyn",
    hops: [
      {
        router: APESWAP_ROUTER,
        path: [process.env.CAS_TOKEN_ADDRESS!, WPOL],
        useNativeIn: false,
        useNativeOut: true,
        amountIn: "0",
      },
      {
        router: QUICKSWAP_ROUTER,
        path: [WPOL, WETH],
        useNativeIn: true,
        useNativeOut: false,
        amountIn: "0",
      },
      {
        router: DFYN_ROUTER,
        path: [WETH, process.env.CAS_TOKEN_ADDRESS!],
        useNativeIn: false,
        useNativeOut: false,
        amountIn: "0",
      },
    ],
  },
];

async function main(): Promise<void> {
  const env = requireEnv(["DIAMOND_ADDRESS", "RELAYER_PRIVATE_KEY", "CAS_TOKEN_ADDRESS"]);
  const diamondAddress = env.DIAMOND_ADDRESS;

  const provider = new ethers.JsonRpcProvider(
    process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
  );
  const signer = new ethers.Wallet(env.RELAYER_PRIVATE_KEY, provider);

  log("INFO", "Adding multi-route presets to Diamond", {
    diamond: diamondAddress,
    caller: signer.address,
    routeCount: ROUTES.length,
  });

  const facetAbi = [
    "function addRoute(string name, (address router, address[] path, bool useNativeIn, bool useNativeOut, uint256 amountIn)[] hops) external",
    "function listRoutes() view returns (string[])",
    "function getRoute(string name) view returns ((address router, address[] path, bool useNativeIn, bool useNativeOut, uint256 amountIn)[] hops, string name, bool active)",
  ];
  const facet = new ethers.Contract(diamondAddress, facetAbi, signer);

  // List existing routes
  const existing = await facet.listRoutes();
  log("INFO", "Existing routes", { count: existing.length, routes: existing });

  for (const route of ROUTES) {
    if (existing.includes(route.name)) {
      log("WARN", "Route already exists, skipping", { name: route.name });
      continue;
    }

    log("INFO", "Adding route", {
      name: route.name,
      hops: route.hops.length,
      path: route.hops.map(h => h.path.map(p => p.slice(0, 8)).join("→")).join(" | "),
    });

    let tx;
    try {
      tx = await facet.addRoute(route.name, route.hops);
    } catch (gasErr) {
      log("WARN", "Gas station timeout, retrying with fixed gas price", { name: route.name });
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice ?? 30_000_000_000n;
      tx = await facet.addRoute(route.name, route.hops, { gasPrice, gasLimit: 500_000 });
    }
    log("INFO", "TX sent", { name: route.name, txHash: tx.hash });
    await tx.wait();
    log("INFO", "Route added", { name: route.name });
  }

  // Verify
  const finalRoutes = await facet.listRoutes();
  log("INFO", "Final routes", { count: finalRoutes.length, routes: finalRoutes });

  for (const name of finalRoutes) {
    try {
      const route = await facet.getRoute(name);
      log("INFO", "Route detail", {
        name: route.name,
        active: route.active,
        hops: route.hops.length,
      });
    } catch (decodeErr) {
      log("WARN", "Could not decode route detail (route exists, decode mismatch)", { name, error: (decodeErr as Error).message });
    }
  }

  console.log("\n✅ Multi-route presets cadastradas!");
  console.log(`   Diamond: ${diamondAddress}`);
  console.log(`   Routes: ${finalRoutes.join(", ")}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "Fatal", { error: err.message });
    console.error(err);
    process.exit(1);
  });
