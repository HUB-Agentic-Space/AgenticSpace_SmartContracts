import "dotenv/config";
import { ethers } from "hardhat";

async function main(): Promise<void> {
  const { CAS_TOKEN_ADDRESS } = process.env;
  if (!CAS_TOKEN_ADDRESS) {
    console.error("Missing CAS_TOKEN_ADDRESS");
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const CAS_ABI = [
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function COMPLIANCE_ROLE() view returns (bytes32)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
    "function isFrozen(address) view returns (bool)",
    "function paused() view returns (bool)",
    "function freeze(address) external",
    "function freezeUntil(address, uint256) external",
    "function freezeUntilOf(address) view returns (uint256)",
  ];

  const cas = new ethers.Contract(CAS_TOKEN_ADDRESS, CAS_ABI, deployer);

  const COMPLIANCE_ROLE = await cas.COMPLIANCE_ROLE();
  const DEFAULT_ADMIN_ROLE = await cas.DEFAULT_ADMIN_ROLE();

  const hasCompliance = await cas.hasRole(COMPLIANCE_ROLE, deployer.address);
  const hasAdmin = await cas.hasRole(DEFAULT_ADMIN_ROLE, deployer.address);

  console.log(`\n=== Role Check ===`);
  console.log(`COMPLIANCE_ROLE: ${hasCompliance}`);
  console.log(`DEFAULT_ADMIN_ROLE: ${hasAdmin}`);

  const testAddresses = [
    "0xcb8bb6bef70b288bf1767766b55947e2650d7dc2",
    "0x93300e631ec66e918811785598476f738da7d5eb",
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000003",
    "0x0000000000000000000000000000000000000004",
    "0x0000000000000000000000000000000000000005",
    "0x0000000000000000000000000000000000000006",
    "0x0000000000000000000000000000000000000007",
    "0x0000000000000000000000000000000000000008",
    "0x0000000000000000000000000000000000000009",
    "0x000000000000000000000000000000000000000a",
  ];

  const paused = await cas.paused();
  console.log(`\n=== Contract State ===`);
  console.log(`Paused: ${paused}`);

  for (const addr of testAddresses) {
    const frozen = await cas.isFrozen(addr);
    const freezeUntil = await cas.freezeUntilOf(addr);
    console.log(`\n=== Address: ${addr} ===`);
    console.log(`  isFrozen: ${frozen}`);
    console.log(`  freezeUntil: ${freezeUntil}`);
  }

  if (!hasCompliance) {
    console.log(`\n❌ Deployer NÃO tem COMPLIANCE_ROLE — este é o motivo da reversão.`);
    console.log(`   O script 18_upgrade_cas_token.ts concede a role ao deployer.`);
    console.log(`   Se o deployer renunciou ou perdeu a role, é necessário concedê-la novamente.`);
    console.log(`   Para conceder: npx hardhat run scripts/18_upgrade_cas_token.ts --network polygon`);
  } else {
    console.log(`\n✅ Deployer tem COMPLIANCE_ROLE. Tentando freeze em endereço de teste...`);
    const testAddr = "0x0000000000000000000000000000000000000001";
    try {
      const tx = await cas.freeze(testAddr);
      const receipt = await tx.wait();
      console.log(`✅ Freeze bem-sucedido! tx: ${receipt?.hash}`);
      console.log(`   Agora desfazendo...`);
      const tx2 = await cas.unfreeze(testAddr);
      await tx2.wait();
      console.log(`✅ Unfreeze bem-sucedido!`);
    } catch (err: any) {
      console.log(`❌ Freeze falhou: ${err.message}`);
      if (err.data) {
        console.log(`   Revert data: ${err.data}`);
      }
      if (err.reason) {
        console.log(`   Revert reason: ${err.reason}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
