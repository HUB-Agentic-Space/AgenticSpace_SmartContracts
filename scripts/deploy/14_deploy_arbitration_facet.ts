import "dotenv/config";
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join } from "path";

async function main(): Promise<void> {
  const rpc = process.env.POLYGON_RPC_URL!;
  const pk = process.env.RELAYER_PRIVATE_KEY!;
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk, provider);

  const artifactPath = join(process.cwd(), "artifacts/contracts/facets/ArbitrationFacet.sol/ArbitrationFacet.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const facet = await factory.deploy();
  await facet.waitForDeployment();
  const addr = await facet.getAddress();
  console.log(`ArbitrationFacet deployed to: ${addr}`);
  console.log(`Set ARBITRATION_FACET_ADDRESS=${addr} in .env`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
