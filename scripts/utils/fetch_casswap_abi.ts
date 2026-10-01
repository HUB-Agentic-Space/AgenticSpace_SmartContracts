import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "node:fs";

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

const address = process.argv[2] || process.env.CAS_SWAP_ADDRESS;
const apiKey = process.env.POLYGONSCAN_API_KEY;

if (!address || !apiKey) {
  console.error("Usage: npx tsx scripts/utils/fetch_casswap_abi.ts [address]");
  console.error("Requires CAS_SWAP_ADDRESS and POLYGONSCAN_API_KEY in .env");
  process.exit(1);
}

async function main(): Promise<void> {
  const url = `https://api.polygonscan.com/api?module=contract&action=getabi&address=${address}&apikey=${apiKey}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status === "1") {
    const abi = JSON.parse(json.result);
    const output = path.join(SC_ROOT, "deployments", `casswap-abi-${address.slice(2, 10)}.json`);
    fs.writeFileSync(output, JSON.stringify(abi, null, 2));
    console.log(`ABI saved to ${output}`);
    const functions = abi.filter((x: any) => x.type === "function").map((x: any) => `${x.name}(${x.inputs.map((i: any) => i.type).join(",")})`);
    console.log("Functions:", functions.join("\n"));
  } else {
    console.error("API error:", json);
    process.exit(1);
  }
}

main().catch(console.error);
