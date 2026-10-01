import { ethers, network } from "hardhat";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DIAMOND = "0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b";
const TIMELOCK = "0x6e14dA17C2B9df7A5d829897F9c39b61D9E8d4B5";
const DELAY = 172800n;
const BPS_DENOMINATOR = 10000n;
const FEE_BPS = BigInt(process.env.SWAP_FEE_BPS ?? "50");

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [37_prepare_casswap_fee_timelock:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");
  if (FEE_BPS > BPS_DENOMINATOR) throw new Error(`feeBps ${FEE_BPS} exceeds BPS_DENOMINATOR`);

  const swap = new ethers.Contract(DIAMOND, ["function getSwapFeeBps() view returns(uint256)"], ethers.provider);
  const currentFee = await swap.getSwapFeeBps();
  log("info", "current_state", `currentFeeBps=${currentFee} targetFeeBps=${FEE_BPS}`);
  if (currentFee === FEE_BPS) {
    log("info", "fee_already_set", `feeBps=${FEE_BPS}`);
    return;
  }

  const swapInterface = new ethers.Interface(["function setSwapFeeBps(uint256 newFeeBps)"]);
  const swapCalldata = swapInterface.encodeFunctionData("setSwapFeeBps", [FEE_BPS]);
  const predecessor = ethers.ZeroHash;
  const salt = ethers.keccak256(ethers.toUtf8Bytes(`CASSwapUSDCPOLFacet:setSwapFeeBps:${FEE_BPS}`));
  const timelockInterface = new ethers.Interface([
    "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
    "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) view returns(bytes32)",
  ]);
  const scheduleCalldata = timelockInterface.encodeFunctionData("schedule", [DIAMOND, 0, swapCalldata, predecessor, salt, DELAY]);
  const timelock = new ethers.Contract(TIMELOCK, timelockInterface, ethers.provider);
  const operationId = await timelock.hashOperation(DIAMOND, 0, swapCalldata, predecessor, salt);

  const output = {
    network: network.name,
    chainId: 137,
    diamond: DIAMOND,
    timelock: TIMELOCK,
    feeBps: FEE_BPS.toString(),
    previousFeeBps: currentFee.toString(),
    swapCalldata,
    predecessor,
    salt,
    delaySeconds: DELAY.toString(),
    operationId,
    safeScheduleTransaction: { to: TIMELOCK, value: "0", data: scheduleCalldata },
  };
  const outputPath = resolve(__dirname, "../../deployments/casswap-swapfee.json");
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  log("info", "fee_change_prepared", `feeBps=${FEE_BPS} operationId=${operationId} output=${outputPath}`);
}

main().catch((error) => {
  log("error", "preparation_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
