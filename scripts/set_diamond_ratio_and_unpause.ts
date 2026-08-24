import { ethers } from "hardhat";
import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(__dirname, "..", ".env") });

/**
 * Define ratio CAS/POL e CAS/USDC no Diamond e despausa o swap.
 * Usa RELAYER_PRIVATE_KEY (Diamond owner).
 *
 * Uso: npx hardhat run scripts/set_diamond_ratio_and_unpause.ts --network polygon
 */

const DIAMOND_SWAP_ABI = [
  "function setSwapRatio(uint256 numerator, uint256 denominator) external",
  "function setSwapRatioUSDC(uint256 numerator, uint256 denominator) external",
  "function getRatio() external view returns (uint256 numerator, uint256 denominator)",
  "function getRatioUSDC() external view returns (uint256 numerator, uint256 denominator)",
  "function isSwapPaused() external view returns (bool)",
  "function unpauseSwap() external",
];

const CHAINLINK_FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/set_diamond_ratio_and_unpause.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  const [defaultSigner] = await ethers.getSigners();
  const provider = defaultSigner.provider!;
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  const diamondAddr = process.env.DIAMOND_ADDRESS;
  const chainlinkFeedAddr = process.env.CHAINLINK_POL_USD_FEED;
  const relayerKey = process.env.RELAYER_PRIVATE_KEY;

  if (!diamondAddr) throw new Error("DIAMOND_ADDRESS not set");
  if (!chainlinkFeedAddr) throw new Error("CHAINLINK_POL_USD_FEED not set");
  if (!relayerKey) throw new Error("RELAYER_PRIVATE_KEY not set");

  // Use relayer wallet (Diamond owner)
  const relayer = new ethers.Wallet(relayerKey, provider);

  console.log("\n============================================================");
  console.log("  Diamond: Set Ratio + Unpause");
  console.log("============================================================");
  console.log(`  Network:  ${chainId === 137 ? "Polygon Mainnet" : `Chain ${chainId}`}`);
  console.log(`  Relayer:  ${relayer.address}`);

  if (chainId !== 137) {
    log("ERROR", "Script deve rodar na Polygon mainnet (137)", { chainId });
    process.exit(1);
  }

  // Verify owner
  const owner = await new ethers.Contract(
    diamondAddr,
    ["function owner() view returns (address)"],
    relayer,
  ).owner();

  if (relayer.address.toLowerCase() !== owner.toLowerCase()) {
    log("ERROR", "Relayer must be the Diamond owner", { relayer: relayer.address, owner });
    process.exit(1);
  }

  // ── 1. Chainlink POL/USD ─────────────────────────────────────────
  const feed = new ethers.Contract(chainlinkFeedAddr, CHAINLINK_FEED_ABI, relayer);
  const [decimals, round] = await Promise.all([feed.decimals(), feed.latestRoundData()]);
  const answer = BigInt(round.answer);
  const updatedAt = Number(round.updatedAt);
  const latestBlock = await provider.getBlock("latest");
  const age = latestBlock!.timestamp - updatedAt;

  if (answer <= 0n) throw new Error("Invalid Chainlink answer");
  if (age > 3600) throw new Error(`Chainlink price stale: ${age}s`);

  const polUsdcPrice6 = (answer * 1_000_000n) / 10n ** BigInt(decimals);
  const polUsdcFloat = Number(polUsdcPrice6) / 1_000_000;
  console.log(`\n  Chainlink: 1 POL = ${polUsdcFloat} USDC (${age}s old)`);

  // ── 2. Compute ratios ────────────────────────────────────────────
  // 1 CAS = 0.0006 POL  =>  1 POL = 1666.6667 CAS
  const casPerPolFloat = 5000 / 3;

  // Diamond POL: scaled by 1e18
  const diamondPolNum = ethers.parseEther("5000");
  const diamondPolDen = ethers.parseEther("3");

  // Diamond USDC: casPerUsdc = casPerPol * 1e6 / polUsdcPrice6
  const casPerUsdcFloat = (casPerPolFloat * 1_000_000) / Number(polUsdcPrice6);
  const ratioUsdcNum = ethers.parseUnits(casPerUsdcFloat.toFixed(12), 12);
  const ratioUsdcDen = 1n;

  console.log(`  CAS/POL:  1 POL = ${casPerPolFloat.toFixed(4)} CAS  (1 CAS = 0.0006 POL)`);
  console.log(`  CAS/USDC: 1 USDC = ${casPerUsdcFloat.toFixed(4)} CAS`);

  // ── 3. Current state ─────────────────────────────────────────────
  const diamond = new ethers.Contract(diamondAddr, DIAMOND_SWAP_ABI, relayer);
  const [curPolNum, curPolDen] = await diamond.getRatio();
  const [curUsdcNum, curUsdcDen] = await diamond.getRatioUSDC();
  const curPaused = await diamond.isSwapPaused();
  log("INFO", "Estado atual", {
    pol: `${curPolNum}/${curPolDen}`,
    usdc: `${curUsdcNum}/${curUsdcDen}`,
    paused: curPaused,
  });

  // ── 4. Unpause if needed ─────────────────────────────────────────
  if (curPaused) {
    log("INFO", "Unpausing Diamond swap...");
    const txUnpause = await diamond.unpauseSwap();
    await txUnpause.wait();
    log("OK", "Diamond unpaused", { tx: txUnpause.hash });
  }

  // ── 5. Set POL ratio ─────────────────────────────────────────────
  if (curPolNum !== diamondPolNum || curPolDen !== diamondPolDen) {
    log("INFO", "Setting POL ratio...", { num: diamondPolNum.toString(), den: diamondPolDen.toString() });
    const txPol = await diamond.setSwapRatio(diamondPolNum, diamondPolDen);
    await txPol.wait();
    log("OK", "POL ratio set", { tx: txPol.hash });
  } else {
    log("INFO", "POL ratio already correct");
  }

  // ── 6. Set USDC ratio ────────────────────────────────────────────
  if (curUsdcNum !== ratioUsdcNum || curUsdcDen !== ratioUsdcDen) {
    log("INFO", "Setting USDC ratio...", { num: ratioUsdcNum.toString(), den: ratioUsdcDen.toString() });
    const txUsdc = await diamond.setSwapRatioUSDC(ratioUsdcNum, ratioUsdcDen);
    await txUsdc.wait();
    log("OK", "USDC ratio set", { tx: txUsdc.hash });
  } else {
    log("INFO", "USDC ratio already correct");
  }

  // ── 7. Final verification ────────────────────────────────────────
  const [finalPolNum, finalPolDen] = await diamond.getRatio();
  const [finalUsdcNum, finalUsdcDen] = await diamond.getRatioUSDC();
  const finalPaused = await diamond.isSwapPaused();

  console.log("\n------------------------------------------------------------");
  console.log("  Final State");
  console.log("------------------------------------------------------------");
  console.log(`  POL ratio:  ${finalPolNum}/${finalPolDen}`);
  console.log(`  USDC ratio: ${finalUsdcNum}/${finalUsdcDen}`);
  console.log(`  Paused:     ${finalPaused}`);

  if (!finalPaused) {
    console.log("\n============================================================");
    console.log("  ✅ Diamond configurado e despausado com sucesso!");
    console.log("============================================================");
  } else {
    console.log("\n  ⚠️  Diamond ainda pausado — verifique manualmente.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n❌ Falha:", e.reason ?? e.message ?? e);
    process.exit(1);
  });
