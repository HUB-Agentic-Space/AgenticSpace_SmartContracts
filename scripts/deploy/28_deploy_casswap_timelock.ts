import { ethers, network } from "hardhat";

const SAFE = "0x1743abe1A64DAB3c81e394adb4e3B56ef05F0D26";
const DELAY = 172800n;

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [28_deploy_casswap_timelock:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  if (balance === 0n) throw new Error("Deployer has no POL for gas");

  const factory = await ethers.getContractFactory("AgenticSpaceTimelock", deployer);
  const deployment = await factory.getDeployTransaction(DELAY, [SAFE], [ethers.ZeroAddress], SAFE);
  const estimatedGas = await ethers.provider.estimateGas({ ...deployment, from: deployer.address });
  log("info", "deployment_simulated", `deployer=${deployer.address} delay=${DELAY} proposer=${SAFE} executor=${ethers.ZeroAddress} admin=${SAFE} estimatedGas=${estimatedGas}`);

  const timelock = await factory.deploy(DELAY, [SAFE], [ethers.ZeroAddress], SAFE);
  await timelock.waitForDeployment();
  const address = await timelock.getAddress();
  const proposerRole = await timelock.PROPOSER_ROLE();
  const executorRole = await timelock.EXECUTOR_ROLE();
  if (await timelock.getMinDelay() !== DELAY) throw new Error("Unexpected timelock delay");
  if (!(await timelock.hasRole(proposerRole, SAFE))) throw new Error("Safe is not proposer");
  if (!(await timelock.hasRole(executorRole, ethers.ZeroAddress))) throw new Error("Executor role is not open");
  const receipt = await timelock.deploymentTransaction()?.wait();
  log("info", "deployment_confirmed", `timelock=${address} tx=${receipt?.hash} block=${receipt?.blockNumber}`);
}

main().catch((error) => {
  log("error", "deployment_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
