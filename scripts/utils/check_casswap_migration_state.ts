import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as path from "path";

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

const CAS_SWAP_ADDRESS = process.env.CAS_SWAP_ADDRESS!;
const INFRASTRUCTURE_FUND_ADDRESS = process.env.INFRASTRUCTURE_FUND_ADDRESS!;
const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS!;
const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS!;
const DEPLOYER_ADDRESS = process.env.DEPLOYER_ADDRESS!;
const RAPPORT_ADDRESS = process.env.RAPPORT_ADDRESS!;
const AUTHOR_ADDRESS = process.env.AUTHOR_ADDRESS!;
const RELAYER_ADDRESS = process.env.RELAYER_ADDRESS!;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const CASSWAP_ABI = [
  "function paused() view returns (bool)",
  "function getCASBalance() view returns (uint256)",
  "function getPOLBalance() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

const INFRA_FUND_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function rapportAddress() view returns (address)",
  "function authorAddress() view returns (address)",
];

const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TREASURER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TREASURER_ROLE"));
const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] [check_casswap_migration_state] ${level} ${message}${params ? ` - ${JSON.stringify(params)}` : ""}`);
}

async function main(): Promise<void> {
  const provider = ethers.provider;
  const network = await provider.getNetwork();
  log("INFO", "network", { chainId: Number(network.chainId), name: network.name });

  const casToken = new ethers.Contract(CAS_TOKEN_ADDRESS, ERC20_ABI, provider);
  const casSwap = new ethers.Contract(CAS_SWAP_ADDRESS, CASSWAP_ABI, provider);
  const infraFund = new ethers.Contract(INFRASTRUCTURE_FUND_ADDRESS, INFRA_FUND_ABI, provider);

  const decimals = await casToken.decimals();
  const symbol = await casToken.symbol();

  const casSwapCas = await casToken.balanceOf(CAS_SWAP_ADDRESS);
  const casSwapPol = await provider.getBalance(CAS_SWAP_ADDRESS);
  const infraFundCas = await casToken.balanceOf(INFRASTRUCTURE_FUND_ADDRESS);
  const infraFundPol = await provider.getBalance(INFRASTRUCTURE_FUND_ADDRESS);
  const diamondCas = await casToken.balanceOf(DIAMOND_ADDRESS);
  const diamondPol = await provider.getBalance(DIAMOND_ADDRESS);
  const deployerCas = await casToken.balanceOf(DEPLOYER_ADDRESS);
  const deployerPol = await provider.getBalance(DEPLOYER_ADDRESS);
  const relayerCas = await casToken.balanceOf(RELAYER_ADDRESS);
  const relayerPol = await provider.getBalance(RELAYER_ADDRESS);

  const paused = await casSwap.paused();

  const deployerIsAdmin = await casSwap.hasRole(DEFAULT_ADMIN_ROLE, DEPLOYER_ADDRESS);
  const relayerIsAdmin = await casSwap.hasRole(DEFAULT_ADMIN_ROLE, RELAYER_ADDRESS);
  const deployerIsTreasurer = await infraFund.hasRole(TREASURER_ROLE, DEPLOYER_ADDRESS);
  const deployerIsPauser = await casSwap.hasRole(PAUSER_ROLE, DEPLOYER_ADDRESS);

  const fmt = (v: bigint) => ethers.formatUnits(v, decimals);
  const fmtPol = (v: bigint) => ethers.formatEther(v);

  log("INFO", "balances", {
    token: `${symbol} (${decimals} decimals)`,
    casSwap: { cas: fmt(casSwapCas), pol: fmtPol(casSwapPol) },
    infraFund: { cas: fmt(infraFundCas), pol: fmtPol(infraFundPol) },
    diamond: { cas: fmt(diamondCas), pol: fmtPol(diamondPol) },
    deployer: { cas: fmt(deployerCas), pol: fmtPol(deployerPol) },
    relayer: { cas: fmt(relayerCas), pol: fmtPol(relayerPol) },
  });

  log("INFO", "state", {
    casSwapPaused: paused,
    deployerIsDefaultAdmin: deployerIsAdmin,
    relayerIsDefaultAdmin: relayerIsAdmin,
    deployerIsTreasurer: deployerIsTreasurer,
    deployerIsPauser: deployerIsPauser,
    rapportAddress: await infraFund.rapportAddress(),
    authorAddress: await infraFund.authorAddress(),
  });

  if (!deployerIsAdmin && !relayerIsAdmin) {
    log("ERROR", "no_admin_role_for_deployer_or_relayer", { deployer: DEPLOYER_ADDRESS, relayer: RELAYER_ADDRESS });
  }
  if (!deployerIsTreasurer) {
    log("ERROR", "deployer_is_not_treasurer", { deployer: DEPLOYER_ADDRESS });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
