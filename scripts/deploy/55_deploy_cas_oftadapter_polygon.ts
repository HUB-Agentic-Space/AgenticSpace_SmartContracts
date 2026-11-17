/**
 * @file 55_deploy_cas_oftadapter_polygon.ts
 * @notice Deploy do CASOFTAdapter (LayerZero OFT lock/unlock) na Polygon.
 * @dev    O adapter trava o CASToken existente e emite recibos cross-chain
 *         que liberam mint do CASOFT na BSC. Executa:
 *
 *           1. Valida rede (Polygon mainnet) e envs (CAS_TOKEN_ADDRESS,
 *              LZ_ENDPOINT, LZ_EID_POLYGON).
 *           2. Deploy do CASOFTAdapter(token=CAS, endpoint, delegate=deployer).
 *           3. Imprime endereco para registrar em CAS_OFT_ADAPTER_POLYGON.
 *
 *         Proximo passo: deploy do CASOFT na BSC (56) + setPeer nas duas
 *         pontas (scripts/deploy/56_deploy_cas_oft_bsc.ts).
 *
 *         Uso:
 *           npx hardhat run scripts/deploy/55_deploy_cas_oftadapter_polygon.ts --network polygon
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
} from "../utils/deploy_helpers";

const FILE = "scripts/deploy/55_deploy_cas_oftadapter_polygon.ts";

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${FILE}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Deploy CASOFTAdapter — bridge CAS (Polygon -> BSC, LayerZero)");
  console.log(SEP);

  const env = requireEnv(["CAS_TOKEN_ADDRESS", "LZ_ENDPOINT"]);
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);

  console.log(`\n${SUB}\n  Rede\n${SUB}`);
  console.log(`  Rede:      ${netInfo.name}`);
  console.log(`  Chain ID:  ${chainId}`);
  console.log(`  Deployer:  ${deployer.address}`);

  if (chainId !== 137) {
    log("ERROR", "Abortando: script deve rodar na Polygon mainnet (137)", { chainId });
    process.exit(1);
  }

  const casAddress = env.CAS_TOKEN_ADDRESS;
  const lzEndpoint = env.LZ_ENDPOINT;
  const delegate = process.env.OFT_DELEGATE_ADDRESS ?? deployer.address;

  const cas = new ethers.Contract(
    casAddress,
    ["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function paused() view returns (bool)"],
    provider,
  );
  const [symbol, paused] = await Promise.all([cas.symbol(), cas.paused()]);
  log("INFO", "Token de origem", { cas: casAddress, symbol, paused });

  console.log(`\n${SUB}\n  Parametros\n${SUB}`);
  console.log(`  CAS (innerToken): ${casAddress}`);
  console.log(`  LZ EndpointV2:    ${lzEndpoint}`);
  console.log(`  Delegate (owner): ${delegate}`);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 30_000_000_000n;
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);

  const factory = await ethers.getContractFactory("CASOFTAdapter");
  const adapter = await factory.deploy(casAddress, lzEndpoint, delegate, { gasPrice });
  console.log(`\n${SUB}\n  Deploy\n${SUB}`);
  console.log(`  TX: ${adapter.deploymentTransaction()?.hash}`);
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();

  // Sanidade: endpoint e token gravados corretamente.
  const endpointOnChain = await adapter.endpoint();
  const innerToken = await adapter.token();
  log("INFO", "CASOFTAdapter deployado", {
    adapter: adapterAddress,
    endpoint: endpointOnChain,
    innerToken,
  });

  console.log(`\n${SUB}\n  Resultado\n${SUB}`);
  console.log(`  CASOFTAdapter: ${adapterAddress}`);
  console.log(`  Endpoint:      ${endpointOnChain}`);
  console.log(`  Inner token:   ${innerToken}`);
  console.log(`\n  Proximos passos:`);
  console.log(`    1. Atualize .env: CAS_OFT_ADAPTER_POLYGON=${adapterAddress}`);
  console.log(`    2. Deploy do CASOFT na BSC:`);
  console.log(`       npm run deploy:oft:bsc`);
  console.log(`    3. setPeer nas duas pontas (script 56 faz automatico)`);
  console.log(`\n${SEP}\n`);

  log("INFO", "concluido", { adapter: adapterAddress });
}

main().catch((err) => {
  log("ERROR", "falha nao tratada", { error: String(err?.message ?? err) });
  console.error(err);
  process.exit(1);
});
