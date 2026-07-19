import { run } from "hardhat";
import dotenv from "dotenv";

dotenv.config();

/**
 * Verifica o contrato RapportCertificate no Polygonscan.
 * Os argumentos do construtor devem corresponder exatamente aos
 * usados no deploy (scripts/deploy/12_deploy_rapport_certificate.ts).
 *
 * Uso:
 *   RAPPORT_CERTIFICATE_ADDRESS=0x... npx hardhat run scripts/verify_rapport_certificate.ts --network polygon
 */
async function main() {
  const certificateAddress = process.env.RAPPORT_CERTIFICATE_ADDRESS?.trim();
  if (!certificateAddress || !/^0x[0-9a-fA-F]{40}$/.test(certificateAddress)) {
    throw new Error("RAPPORT_CERTIFICATE_ADDRESS must be set to a valid address in .env");
  }

  const constructorArguments = [
    process.env.CERTIFICATE_ADMIN_ADDRESS || "0x66682BBeD9e540017967692cCdd069fE5F833888",
    process.env.CAS_TOKEN_ADDRESS || "0x5151A34EaC7bA08cd6B540b32cD30316218A2287",
    process.env.ERC6551_REGISTRY_ADDRESS || "0x000000006551c19487814612e58FE06813775758",
    process.env.CERTIFICATE_ACCOUNT_IMPLEMENTATION_ADDRESS || "0x20D019bd225431eA5894182Cd4F935B178DB550A",
    process.env.CERTIFICATE_BASE_URI || "https://agenticspace.rapport.tec.br/api/v1/certificates/token/",
  ] as const;

  console.log("Verificando RapportCertificate no Polygonscan...");
  console.log(`  Endereco: ${certificateAddress}`);
  console.log(`  Admin: ${constructorArguments[0]}`);
  console.log(`  CAS Token: ${constructorArguments[1]}`);
  console.log(`  Registry: ${constructorArguments[2]}`);
  console.log(`  Account Impl: ${constructorArguments[3]}`);
  console.log(`  Base URI: ${constructorArguments[4]}`);

  try {
    await run("verify:verify", {
      address: certificateAddress,
      constructorArguments: [...constructorArguments],
    });
    console.log("✅ Verificação concluída com sucesso!");
  } catch (error: any) {
    if (error.message.toLowerCase().includes("already verified")) {
      console.log("ℹ️ Contrato já verificado no Polygonscan.");
    } else {
      console.error("❌ Erro na verificação:", error.message);
      throw error;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
