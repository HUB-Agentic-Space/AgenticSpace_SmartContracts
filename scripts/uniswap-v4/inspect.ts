import { JsonRpcProvider } from "ethers";
import { inventory } from "./pools";

async function main() {
  const provider = new JsonRpcProvider(process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com",
    undefined, { batchMaxCount: 5 });
  try {
    const snapshot = await inventory(provider);
    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    provider.destroy();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
