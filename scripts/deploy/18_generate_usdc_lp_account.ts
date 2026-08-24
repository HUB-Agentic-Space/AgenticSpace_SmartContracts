import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const wallet = ethers.Wallet.createRandom();

  const envFile = path.join(process.cwd(), ".env.usdc");
  const mainEnvFile = path.join(process.cwd(), ".env");

  const lines: string[] = [
    `# Conta LP gerada automaticamente em ${new Date().toISOString()}`,
    `USDC_LP_ADDRESS=${wallet.address}`,
    `USDC_LP_PRIVATE_KEY=${wallet.privateKey}`,
    "",
  ];

  const mainLines: string[] = [
    `# Conta LP CAS/USDC gerada automaticamente em ${new Date().toISOString()}`,
    `USDC_LP_ADDRESS=${wallet.address}`,
    `USDC_LP_PRIVATE_KEY=${wallet.privateKey}`,
    "",
  ];

  fs.appendFileSync(envFile, lines.join("\n"));
  fs.appendFileSync(mainEnvFile, mainLines.join("\n"));

  console.log(`[18] Nova conta LP para liquidez CAS/USDC gerada.`);
  console.log(`  Address : ${wallet.address}`);
  console.log(`  Salvo em: ${envFile}`);
  console.log(`  Copiado para .env para facilitar integracao.`);
  console.log(`\n  IMPORTANTE: anote e proteja a chave privada. Nunca compartilhe publicamente.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
