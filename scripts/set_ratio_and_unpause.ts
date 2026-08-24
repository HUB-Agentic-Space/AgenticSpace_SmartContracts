import { ethers } from "hardhat";
import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(__dirname, "..", ".env") });

/**
 * Script combinado que:
 * 1. Define o ratio CAS/POL em ambos os contratos (standalone + Diamond)
 *    para 1 CAS = 0.0006 POL (1 POL = 1666.6667 CAS).
 * 2. Define o ratio CAS/USDC proporcional via Chainlink POL/USD feed.
 * 3. Despausa o swap em ambos os contratos.
 *
 * Uso: npx hardhat run scripts/set_ratio_and_unpause.ts --network polygon
 */

// 1 CAS = 0.0006 POL  =>  1 POL = 1/0.0006 = 1666.6667 CAS
const CAS_PER_POL = 5000n / 3n; // 1666 (integer part; we use 5000/3 for precision)

const OLD_CASSWAP_ABI = [
  "function setRatio(uint256 numerator, uint256 denominator) external",
  "function getRatio() external view returns (uint256 numerator, uint256 denominator)",
  "function isPaused() external view returns (bool)",
  "function unpause() external",
  "function RATIO_ADMIN_ROLE() external view returns (bytes32)",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function PAUSER_ROLE() external view returns (bytes32)",
];

const DIAMOND_SWAP_ABI = [
  "function setSwapRatio(uint256 numerator, uint256 denominator) external",
  "function setSwapRatioUSDC(uint256 numerator, uint256 denominator) external",
  "function getRatio() external view returns (uint256 numerator, uint256 denominator)",
  "function getRatioUSDC() external view returns (uint256 numerator, uint256 denominator)",
  "function isSwapPaused() external view returns (bool)",
  "function unpauseSwap() external",
  "function pauseSwap() external",
];

const CHAINLINK_FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/set_ratio_and_unpause.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  const [signer] = await ethers.getSigners();
  const provider = signer.provider!;
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  console.log("\n============================================================");
  console.log("  Set Ratio + Unpause CASSwap (standalone + Diamond)");
  console.log("============================================================");
  console.log(`  Network:   ${chainId === 137 ? "Polygon Mainnet" : `Chain ${chainId}`}`);
  console.log(`  Signer:    ${signer.address}`);

  if (chainId !== 137) {
    log("ERROR", "Script deve rodar na Polygon mainnet (137)", { chainId });
    process.exit(1);
  }

  const oldCasswapAddr = process.env.CAS_SWAP_ADDRESS;
  const diamondAddr = process.env.DIAMOND_ADDRESS;
  const chainlinkFeedAddr = process.env.CHAINLINK_POL_USD_FEED;

  if (!oldCasswapAddr) throw new Error("CAS_SWAP_ADDRESS not set in .env");
  if (!diamondAddr) throw new Error("DIAMOND_ADDRESS not set in .env");
  if (!chainlinkFeedAddr) throw new Error("CHAINLINK_POL_USD_FEED not set in .env");

  // ── 1. Fetch POL/USD from Chainlink ──────────────────────────────
  console.log("\n------------------------------------------------------------");
  console.log("  1. Chainlink POL/USD Price");
  console.log("------------------------------------------------------------");

  const feed = new ethers.Contract(chainlinkFeedAddr, CHAINLINK_FEED_ABI, signer);
  const [decimals, round] = await Promise.all([feed.decimals(), feed.latestRoundData()]);
  const answer = BigInt(round.answer);
  const updatedAt = Number(round.updatedAt);
  const latestBlock = await provider.getBlock("latest");
  const age = latestBlock!.timestamp - updatedAt;

  if (answer <= 0n) throw new Error("Invalid Chainlink answer");
  if (age > 3600) throw new Error(`Chainlink price is stale: ${age}s old`);

  // POL/USDC in 6-decimal format (USDC has 6 decimals)
  const polUsdcPrice6 = (answer * 1_000_000n) / 10n ** BigInt(decimals);
  const polUsdcFloat = Number(polUsdcPrice6) / 1_000_000;
  console.log(`  1 POL = ${polUsdcFloat} USDC (Chainlink, ${age}s old)`);

  // ── 2. Compute ratios ────────────────────────────────────────────
  console.log("\n------------------------------------------------------------");
  console.log("  2. Ratio Computation");
  console.log("------------------------------------------------------------");

  // Target: 1 CAS = 0.0006 POL  =>  1 POL = 1666.6667 CAS
  const casPerPolFloat = 5000 / 3; // 1666.6667

  // Old CASSwap: raw integers, casOut = (polAfterFee * num) / den
  // 1 POL = 5000/3 CAS => setRatio(5000, 3)
  const oldNum = 5000n;
  const oldDen = 3n;

  // Diamond POL: scaled by 1e18
  // casOut = (netPol * ratioPolNum) / ratioPolDen
  // netPol = 1e18, casOut should be 1666.6667e18
  // ratioPolNum / ratioPolDen = 1666.6667
  // Use: ratioPolNum = 5000e18, ratioPolDen = 3e18
  const diamondPolNum = ethers.parseEther("5000") / 1n; // 5000e18
  const diamondPolDen = ethers.parseEther("3");          // 3e18

  // Diamond USDC: casOut = (netUsdc * ratioUsdcNum) / ratioUsdcDen
  // netUsdc is in 6-decimal USDC, casOut is in 18-decimal CAS
  // 1 USDC = (1/casPerPolFloat) * (1/polUsdcFloat) ... no
  // 1 USDC = (1 USDC / polUsdcPrice) POL = (1e6 / polUsdcPrice6) * 1e18 POL-wei
  // Then CAS = POL-wei * casPerPol = (1e6 / polUsdcPrice6) * 1e18 * casPerPolFloat
  // But casOut = (netUsdc * ratioUsdcNum) / ratioUsdcDen
  // netUsdc = 1e6, casOut should be casPerUsdc * 1e18
  // casPerUsdc = casPerPol * 1e6 / polUsdcPrice6
  const casPerUsdcFloat = (casPerPolFloat * 1_000_000) / Number(polUsdcPrice6);
  // ratioUsdcNum = casPerUsdc * 1e12, ratioUsdcDen = 1
  // (because USDC has 6 decimals, CAS has 18: 18 - 6 = 12)
  const ratioUsdcNum = ethers.parseUnits(casPerUsdcFloat.toFixed(12), 12);
  const ratioUsdcDen = 1n;

  console.log(`  CAS/POL: 1 CAS = 0.0006 POL  |  1 POL = ${casPerPolFloat.toFixed(4)} CAS`);
  console.log(`  CAS/USDC: 1 USDC = ${casPerUsdcFloat.toFixed(4)} CAS  |  1 CAS = ${(1/casPerUsdcFloat).toFixed(8)} USDC`);
  console.log(`\n  Old CASSwap:  setRatio(${oldNum}, ${oldDen})`);
  console.log(`  Diamond POL:  setSwapRatio(${diamondPolNum}, ${diamondPolDen})`);
  console.log(`  Diamond USDC: setSwapRatioUSDC(${ratioUsdcNum}, ${ratioUsdcDen})`);

  // ── 3. Old CASSwap: set ratio + unpause ──────────────────────────
  console.log("\n------------------------------------------------------------");
  console.log("  3. Old CASSwap (standalone)");
  console.log("------------------------------------------------------------");

  const oldCasswap = new ethers.Contract(oldCasswapAddr, OLD_CASSWAP_ABI, signer);

  const [oldCurNum, oldCurDen] = await oldCasswap.getRatio();
  log("INFO", "Old CASSwap ratio atual", { num: oldCurNum.toString(), den: oldCurDen.toString() });

  const oldPaused = await oldCasswap.isPaused();
  log("INFO", "Old CASSwap paused", { paused: oldPaused });

  // Check RATIO_ADMIN_ROLE
  const ratioAdminRole = await oldCasswap.RATIO_ADMIN_ROLE();
  const hasRatioRole = await oldCasswap.hasRole(ratioAdminRole, signer.address);
  if (!hasRatioRole) {
    log("ERROR", "Signer nao possui RATIO_ADMIN_ROLE no old CASSwap", { signer: signer.address });
    process.exit(1);
  }

  // Unpause if needed
  if (oldPaused) {
    const pauserRole = await oldCasswap.PAUSER_ROLE();
    const hasPauserRole = await oldCasswap.hasRole(pauserRole, signer.address);
    if (!hasPauserRole) {
      log("WARN", "Signer nao possui PAUSER_ROLE no old CASSwap — tentando unpause mesmo assim");
    }
    log("INFO", "Unpausing old CASSwap...");
    const txUnpause = await oldCasswap.unpause();
    await txUnpause.wait();
    log("OK", "Old CASSwap unpaused", { tx: txUnpause.hash });
  }

  // Set ratio
  if (oldCurNum !== oldNum || oldCurDen !== oldDen) {
    log("INFO", "Setting old CASSwap ratio...", { num: oldNum.toString(), den: oldDen.toString() });
    const txRatio = await oldCasswap.setRatio(oldNum, oldDen);
    await txRatio.wait();
    log("OK", "Old CASSwap ratio set", { tx: txRatio.hash });

    const [newNum, newDen] = await oldCasswap.getRatio();
    log("OK", "Old CASSwap ratio confirmed", { num: newNum.toString(), den: newDen.toString() });
  } else {
    log("INFO", "Old CASSwap ratio already correct — skipping");
  }

  // ── 4. Diamond: set ratios + unpause ─────────────────────────────
  console.log("\n------------------------------------------------------------");
  console.log("  4. Diamond CASSwapUSDCPOLFacet");
  console.log("------------------------------------------------------------");

  const diamond = new ethers.Contract(diamondAddr, DIAMOND_SWAP_ABI, signer);

  // Verify owner
  const owner = await new ethers.Contract(
    diamondAddr,
    ["function owner() view returns (address)"],
    signer,
  ).owner();

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    log("ERROR", "Signer must be the Diamond owner", { signer: signer.address, owner });
    process.exit(1);
  }

  const [diaPolNum, diaPolDen] = await diamond.getRatio();
  const [diaUsdcNum, diaUsdcDen] = await diamond.getRatioUSDC();
  const diaPaused = await diamond.isSwapPaused();
  log("INFO", "Diamond ratio atual", {
    pol: `${diaPolNum}/${diaPolDen}`,
    usdc: `${diaUsdcNum}/${diaUsdcDen}`,
    paused: diaPaused,
  });

  // Unpause if needed (must unpause before setting ratios)
  if (diaPaused) {
    log("INFO", "Unpausing Diamond swap...");
    const txUnpause = await diamond.unpauseSwap();
    await txUnpause.wait();
    log("OK", "Diamond swap unpaused", { tx: txUnpause.hash });
  }

  // Set POL ratio
  if (diaPolNum !== diamondPolNum || diaPolDen !== diamondPolDen) {
    log("INFO", "Setting Diamond POL ratio...");
    const txPol = await diamond.setSwapRatio(diamondPolNum, diamondPolDen);
    await txPol.wait();
    log("OK", "Diamond POL ratio set", { tx: txPol.hash });
  } else {
    log("INFO", "Diamond POL ratio already correct — skipping");
  }

  // Set USDC ratio
  if (diaUsdcNum !== ratioUsdcNum || diaUsdcDen !== ratioUsdcDen) {
    log("INFO", "Setting Diamond USDC ratio...");
    const txUsdc = await diamond.setSwapRatioUSDC(ratioUsdcNum, ratioUsdcDen);
    await txUsdc.wait();
    log("OK", "Diamond USDC ratio set", { tx: txUsdc.hash });
  } else {
    log("INFO", "Diamond USDC ratio already correct — skipping");
  }

  // ── 5. Final verification ────────────────────────────────────────
  console.log("\n------------------------------------------------------------");
  console.log("  5. Final Verification");
  console.log("------------------------------------------------------------");

  const [finalOldNum, finalOldDen] = await oldCasswap.getRatio();
  const finalOldPaused = await oldCasswap.isPaused();
  const [finalPolNum, finalPolDen] = await diamond.getRatio();
  const [finalUsdcNum, finalUsdcDen] = await diamond.getRatioUSDC();
  const finalDiaPaused = await diamond.isSwapPaused();

  console.log("\n  Old CASSwap:");
  console.log(`    Ratio:  ${finalOldNum}/${finalOldDen}  (1 POL = ${(Number(finalOldNum)/Number(finalOldDen)).toFixed(4)} CAS)`);
  console.log(`    Paused: ${finalOldPaused}`);

  console.log("\n  Diamond CASSwapUSDCPOLFacet:");
  console.log(`    POL ratio:  ${finalPolNum}/${finalPolDen}`);
  console.log(`    USDC ratio: ${finalUsdcNum}/${finalUsdcDen}`);
  console.log(`    Paused:     ${finalDiaPaused}`);

  const allGood = !finalOldPaused && !finalDiaPaused
    && finalOldNum === oldNum && finalOldDen === oldDen;

  if (allGood) {
    console.log("\n============================================================");
    console.log("  ✅ Tudo configurado e despausado com sucesso!");
    console.log("============================================================");
  } else {
    console.log("\n============================================================");
    console.log("  ⚠️  Verifique os valores acima — algo pode não estar correto.");
    console.log("============================================================");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n❌ Falha:", e.reason ?? e.message ?? e);
    process.exit(1);
  });
