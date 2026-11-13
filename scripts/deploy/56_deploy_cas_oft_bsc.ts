/**
 * @file 56_deploy_cas_oft_bsc.ts
 * @notice Deploy do CASOFT na BSC + wiring LayerZero (setPeer bidirecional).
 * @dev    Executa na BSC (chainId 56 ou 97) e conecta num segundo provider
 *         Polygon para completar o wiring:
 *
 *           1. Deploy do CASOFT(endpoint, delegate=deployer) na BSC.
 *           2. CASOFT.setPeer(LZ_EID_POLYGON, bytes32(CAS_OFT_ADAPTER_POLYGON)).
 *           3. CASOFTAdapter.setPeer(LZ_EID_BSC, bytes32(CASOFT)) via provider
 *              Polygon separado (mesma chave do deployer).
 *
 *         Uso:
 *           npx hardhat run scripts/deploy/56_deploy_cas_oft_bsc.ts --network bsc
 *           npx hardhat run scripts/deploy/56_deploy_cas_oft_bsc.ts --network bscTestnet
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */
import "dotenv/config";
import { ethers } from "hardhat";
import {
  SEP,
  SUB,
  fmtGwei,
  getNetworkInfo,
  requireEnv,
  sendAndVerify,
} from "../utils/deploy_helpers";

const FILE = "scripts/deploy/56_deploy_cas_oft_bsc.ts";

const OAPP_ABI = [
  "function setPeer(uint32 _eid, bytes32 _peer) external",
  "function peers(uint32 _eid) view returns (bytes32)",
  "function endpoint() view returns (address)",
];

const ADAPTER_ABI = [
  ...OAPP_ABI,
  "function token() view returns (address)",
];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${FILE}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Deploy CASOFT — BSC + wiring LayerZero (setPeer)");
  console.log(SEP);

  const env = requireEnv([
    "LZ_ENDPOINT",
    "LZ_EID_POLYGON",
    "LZ_EID_BSC",
    "CAS_OFT_ADAPTER_POLYGON",
    "POLYGON_PRIVATE_KEY",
  ]);
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);

  console.log(`\n${SUB}\n  Rede\n${SUB}`);
  console.log(`  Rede:      ${netInfo.name}`);
  console.log(`  Chain ID:  ${chainId}`);
  console.log(`  Deployer:  ${deployer.address}`);

  if (chainId !== 56 && chainId !== 97) {
    log("ERROR", "Abortando: script deve rodar na BSC (56 ou 97)", { chainId });
    process.exit(1);
  }

  const lzEndpoint = env.LZ_ENDPOINT;
  const eidPolygon = Number(env.LZ_EID_POLYGON);
  const eidBsc = Number(env.LZ_EID_BSC);
  const adapterPolygon = env.CAS_OFT_ADAPTER_POLYGON;
  const delegate = process.env.OFT_DELEGATE_ADDRESS ?? deployer.address;

  console.log(`\n${SUB}\n  Parametros\n${SUB}`);
  console.log(`  LZ EndpointV2:       ${lzEndpoint}`);
  console.log(`  Delegate (owner):    ${delegate}`);
  console.log(`  Adapter (Polygon):   ${adapterPolygon}`);
  console.log(`  EID Polygon:         ${eidPolygon}`);
  console.log(`  EID BSC:             ${eidBsc}`);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 3_000_000_000n;
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);

  // ── 1. Deploy CASOFT ───────────────────────────────────────────────
  console.log(`\n${SUB}\n  Deploy CASOFT\n${SUB}`);
  const factory = await ethers.getContractFactory("CASOFT");
  const oft = await factory.deploy(lzEndpoint, delegate, { gasPrice });
  console.log(`  TX: ${oft.deploymentTransaction()?.hash}`);
  await oft.waitForDeployment();
  const oftAddress = await oft.getAddress();

  const [symbol, name, decimals] = await Promise.all([
    oft.symbol(), oft.name(), oft.decimals(),
  ]);
  log("INFO", "CASOFT deployado", {
    oft: oftAddress, name, symbol, decimals: Number(decimals),
  });
  console.log(`  CASOFT:   ${oftAddress}`);
  console.log(`  Token:    ${name} (${symbol}) — ${decimals} dec`);

  // ── 2. setPeer na BSC: CASOFT -> adapter Polygon ───────────────────
  console.log(`\n${SUB}\n  setPeer BSC -> Polygon\n${SUB}`);
  const adapterB32 = ethers.zeroPadValue(adapterPolygon, 32);
  const oftContract = new ethers.Contract(oftAddress, OAPP_ABI, deployer);
  const peerBsc = await oftContract.peers(eidPolygon);
  if (peerBsc.toLowerCase() === adapterB32.toLowerCase()) {
    console.log(`  Peer ja configurado — pulando.`);
  } else {
    await sendAndVerify(
      `CASOFT.setPeer(${eidPolygon}, adapter)`,
      oftContract.setPeer(eidPolygon, adapterB32, { gasPrice }),
      gasPrice,
    );
  }

  // ── 3. setPeer na Polygon: adapter -> CASOFT ───────────────────────
  console.log(`\n${SUB}\n  setPeer Polygon -> BSC\n${SUB}`);
  const polygonRpc = process.env.POLYGON_RPC_URL ?? "https://polygon.drpc.org";
  const polygonProvider = new ethers.JsonRpcProvider(polygonRpc);
  const polygonSigner = new ethers.Wallet(env.POLYGON_PRIVATE_KEY, polygonProvider);
  const adapter = new ethers.Contract(adapterPolygon, ADAPTER_ABI, polygonSigner);

  const oftB32 = ethers.zeroPadValue(oftAddress, 32);
  const peerPolygon = await adapter.peers(eidBsc);
  if (peerPolygon.toLowerCase() === oftB32.toLowerCase()) {
    console.log(`  Peer ja configurado — pulando.`);
  } else {
    await sendAndVerify(
      `CASOFTAdapter.setPeer(${eidBsc}, CASOFT)`,
      adapter.setPeer(eidBsc, oftB32),
      await polygonProvider.getFeeData().then((f) => f.gasPrice ?? 30_000_000_000n),
    );
  }

  // ── Resultado ──────────────────────────────────────────────────────
  console.log(`\n${SUB}\n  Resultado\n${SUB}`);
  console.log(`  CASOFT (BSC):          ${oftAddress}`);
  console.log(`  Adapter (Polygon):     ${adapterPolygon}`);
  console.log(`  Wiring:                peer(eid=${eidPolygon}) <-> peer(eid=${eidBsc})`);
  console.log(`\n  Proximos passos:`);
  console.log(`    1. Atualize .env: CAS_OFT_BSC=${oftAddress}`);
  console.log(`    2. Mint + bridge de CAS:`);
  console.log(`       npm run bridge:cas:bsc`);
  console.log(`    3. Seed do BinPool CAS/BNB:`);
  console.log(`       npm run seed:binpool:bsc`);
  console.log(`\n${SEP}\n`);

  log("INFO", "concluido", { oft: oftAddress });
}

main().catch((err) => {
  log("ERROR", "falha nao tratada", { error: String(err?.message ?? err) });
  console.error(err);
  process.exit(1);
});
