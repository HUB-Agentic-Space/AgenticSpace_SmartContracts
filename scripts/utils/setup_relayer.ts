import { ethers } from "hardhat";
import dotenv from "dotenv";

dotenv.config();

/**
 * Setup Relayer — transfere ownership do Diamond para a carteira relayer
 * e/ou concede REGISTRAR_ROLE.
 *
 * Uso:
 *   npx hardhat run scripts/utils/setup_relayer.ts --network polygonAmoy
 *
 * Env vars (smartcontracts/.env ou inline):
 *   DIAMOND_ADDRESS        — endereço do Diamond proxy (obrigatório)
 *   RELAYER_PRIVATE_KEY    — chave privada do relayer (opcional, para derivar o endereço)
 *   RELAYER_ADDRESS        — endereço do relayer (alternativa à chave privada)
 *   DRY_RUN=true           — apenas simula, não envia transação
 *   GRANT_ROLE_ONLY=true   — concede apenas REGISTRAR_ROLE (sem transferir ownership)
 *
 * O que o backend precisa:
 *   - register()     → REGISTRAR_ROLE ou owner
 *   - updateFees()   → apenas owner
 *   - setCasToken()  → apenas owner
 *   Portanto, --transfer é o recomendado para o relayer do backend.
 */

async function main() {
  const dryRun = process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
  const grantRoleOnly =
    process.env.GRANT_ROLE_ONLY === "true" || process.env.GRANT_ROLE_ONLY === "1";
  const transfer = !grantRoleOnly; // padrão: transfer

  const diamondAddress = process.env.DIAMOND_ADDRESS || "";
  if (!diamondAddress) {
    console.error("[setup-relayer] ERRO: DIAMOND_ADDRESS não definido em .env");
    process.exitCode = 1;
    return;
  }

  // Derivar endereço do relayer
  let relayerAddress = process.env.RELAYER_ADDRESS || "";
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY || "";

  if (!relayerAddress && relayerPrivateKey) {
    const wallet = new ethers.Wallet(relayerPrivateKey);
    relayerAddress = wallet.address;
  }

  if (!relayerAddress) {
    console.error(
      "[setup-relayer] ERRO: Defina RELAYER_PRIVATE_KEY ou RELAYER_ADDRESS em .env"
    );
    process.exitCode = 1;
    return;
  }

  const [deployer] = await ethers.getSigners();
  console.log(`[setup-relayer] Network: ${(await ethers.provider.getNetwork()).name}`);
  console.log(`[setup-relayer] Deployer (current signer): ${deployer.address}`);
  console.log(`[setup-relayer] Diamond: ${diamondAddress}`);
  console.log(`[setup-relayer] Relayer address: ${relayerAddress}`);
  console.log(`[setup-relayer] Mode: ${transfer ? "TRANSFER OWNERSHIP" : "GRANT REGISTRAR_ROLE"}`);
  console.log(`[setup-relayer] Dry-run: ${dryRun}`);

  // Conectar ao Diamond via OwnershipFacet e AccessControlFacet
  const ownershipFacet = await ethers.getContractAt("OwnershipFacet", diamondAddress);
  const accessControlFacet = await ethers.getContractAt(
    "AccessControlFacet",
    diamondAddress
  );

  // 1. Verificar owner atual
  const currentOwner = await ownershipFacet.owner();
  console.log(`[setup-relayer] Current Diamond owner: ${currentOwner}`);

  if (currentOwner.toLowerCase() === relayerAddress.toLowerCase()) {
    console.log(`[setup-relayer] Relayer já é o owner. Nada a fazer.`);
    return;
  }

  if (currentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.error(
      `[setup-relayer] ERRO: O deployer (${deployer.address}) não é o owner atual.` +
      ` Owner atual: ${currentOwner}. Use a carteira owner para executar este script.`
    );
    process.exitCode = 1;
    return;
  }

  // 2. Verificar saldo do deployer (precisa de gás)
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`[setup-relayer] Deployer balance: ${ethers.formatEther(balance)} POL`);

  if (balance === 0n) {
    console.error(
      "[setup-relayer] ERRO: Deployer sem saldo. Use um faucet para obter POL de testnet."
    );
    process.exitCode = 1;
    return;
  }

  // 3. Verificar saldo do relayer (para futuras transações)
  const relayerBalance = await ethers.provider.getBalance(relayerAddress);
  console.log(
    `[setup-relayer] Relayer balance: ${ethers.formatEther(relayerBalance)} POL`
  );
  if (relayerBalance === 0n) {
    console.warn(
      "[setup-relayer] AVISO: Relayer sem saldo. Financie com POL de testnet via faucet."
    );
  }

  if (dryRun) {
    console.log(`[setup-relayer] Dry-run ativo — nenhuma transação enviada.`);
    return;
  }

  // 4. Executar
  if (transfer) {
    console.log(`[setup-relayer] Transferindo ownership para ${relayerAddress}...`);
    const tx = await ownershipFacet.transferOwnership(relayerAddress);
    console.log(`[setup-relayer] TX: ${tx.hash}`);
    await tx.wait();
    console.log(`[setup-relayer] Ownership transferida com sucesso.`);

    // Verificar
    const newOwner = await ownershipFacet.owner();
    console.log(`[setup-relayer] Novo owner: ${newOwner}`);
  } else {
    // Grant REGISTRAR_ROLE only
    const registrarRole = await accessControlFacet.REGISTRAR_ROLE();
    console.log(
      `[setup-relayer] Concedendo REGISTRAR_ROLE (${registrarRole}) para ${relayerAddress}...`
    );
    const tx = await accessControlFacet.grantRole(registrarRole, relayerAddress);
    console.log(`[setup-relayer] TX: ${tx.hash}`);
    await tx.wait();
    console.log(`[setup-relayer] REGISTRAR_ROLE concedida com sucesso.`);

    const hasRole = await accessControlFacet.hasRole(registrarRole, relayerAddress);
    console.log(`[setup-relayer] hasRole(REGISTRAR_ROLE): ${hasRole}`);
  }

  console.log(`\n[setup-relayer] === Resumo ===`);
  console.log(`[setup-relayer] Diamond: ${diamondAddress}`);
  console.log(`[setup-relayer] Relayer: ${relayerAddress}`);
  console.log(
    `[setup-relayer] Próximo passo: configurar RELAYER_PRIVATE_KEY no backend/.env ` +
    `e DIAMOND_ADDRESS=${diamondAddress} na Vercel.`
  );
}

main().catch((error) => {
  console.error("[setup-relayer] Erro:", error.message || error);
  process.exitCode = 1;
});
