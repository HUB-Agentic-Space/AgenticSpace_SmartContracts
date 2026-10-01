import { ethers, network } from "hardhat";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * @file 40_prepare_casswap_pause.ts
 * @description Prepara o agendamento do pause do swap no Diamond.
 *              Gera deployments/casswap-pause.json com o calldata de
 *              timelock.schedule(DIAMOND, 0, pauseSwap(), predecessor, salt, delay).
 *              O delay é lido on-chain via getMinDelay() do timelock.
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

const DIAMOND = "0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b";
const TIMELOCK = "0x6e14dA17C2B9df7A5d829897F9c39b61D9E8d4B5";

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [40_prepare_casswap_pause:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");

  const diamond = new ethers.Contract(DIAMOND, [
    "function owner() view returns(address)",
    "function isSwapPaused() view returns(bool)",
  ], ethers.provider);

  const owner = await diamond.owner();
  if (owner.toLowerCase() !== TIMELOCK.toLowerCase()) {
    throw new Error(`Diamond owner is ${owner}, expected timelock ${TIMELOCK}`);
  }

  if (await diamond.isSwapPaused()) {
    log("info", "already_paused", "swap ja esta pausado — nada a preparar");
    return;
  }

  const swapInterface = new ethers.Interface(["function pauseSwap()"]);
  const swapCalldata = swapInterface.encodeFunctionData("pauseSwap");
  const predecessor = ethers.ZeroHash;
  // Salt unico por execucao: permite re-agendar pauses futuros (operationId muda).
  const salt = ethers.keccak256(
    ethers.toUtf8Bytes(`TraderGovernanceFacet:pauseSwap:${new Date().toISOString()}`),
  );
  const timelockInterface = new ethers.Interface([
    "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
    "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) view returns(bytes32)",
    "function getMinDelay() view returns(uint256)",
  ]);
  const timelock = new ethers.Contract(TIMELOCK, timelockInterface, ethers.provider);
  const delay = await timelock.getMinDelay();
  const scheduleCalldata = timelockInterface.encodeFunctionData("schedule", [
    DIAMOND, 0, swapCalldata, predecessor, salt, delay,
  ]);
  const operationId = await timelock.hashOperation(DIAMOND, 0, swapCalldata, predecessor, salt);

  const output = {
    network: network.name,
    chainId: 137,
    diamond: DIAMOND,
    timelock: TIMELOCK,
    action: "pauseSwap",
    swapCalldata,
    predecessor,
    salt,
    delaySeconds: delay.toString(),
    operationId,
    safeScheduleTransaction: { to: TIMELOCK, value: "0", data: scheduleCalldata },
  };
  const outputPath = resolve(__dirname, "../../deployments/casswap-pause.json");
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  log("info", "pause_prepared", `operationId=${operationId} delaySeconds=${delay} output=${outputPath}`);
}

main().catch((error) => {
  log("error", "preparation_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
