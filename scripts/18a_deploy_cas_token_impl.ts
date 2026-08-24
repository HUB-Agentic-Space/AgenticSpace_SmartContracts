import "dotenv/config";
import { ethers, upgrades } from "hardhat";
import { requireEnv, SEP } from "./utils/deploy_helpers";

function log(level: string, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/18a_deploy_cas_token_impl.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:${fn}] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  const { CAS_TOKEN_ADDRESS } = await requireEnv(["CAS_TOKEN_ADDRESS"]);

  const [deployer] = await ethers.getSigners();

  console.log(`\n${SEP}`);
  console.log("  CASToken New Implementation Deploy (UUPS)");
  console.log(SEP);
  console.log(`  Proxy:     ${CAS_TOKEN_ADDRESS}`);
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(SEP);

  const CASToken = await ethers.getContractFactory("CASToken");

  log("INFO", "main", "Deploying new CASToken implementation (no proxy, raw impl)");

  const impl = await CASToken.deploy();
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();

  log("OK", "main", "New implementation deployed", { implAddress });

  console.log(`\n${SEP}`);
  console.log("  ✅ Nova implementação do CASToken deployada!");
  console.log(`  Endereço: ${implAddress}`);
  console.log("");
  console.log("  Próximo passo:");
  console.log(`  1. Adicione no .env:  CAS_TOKEN_NEW_IMPL=${implAddress}`);
  console.log("  2. Execute: npx hardhat run scripts/18_upgrade_cas_token.ts --network polygon");
  console.log(SEP);
}

main().catch((err) => {
  log("ERROR", "main", "Script failed", { error: err.message });
  process.exit(1);
});
