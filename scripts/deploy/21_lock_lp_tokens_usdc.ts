import { ethers } from "hardhat";
import { getUsdcLpEnv, getUsdcLpSigner, getErc20Contract } from "../utils/usdc_lp_helpers";

const FACTORY_ABI = ["function getPair(address,address) view returns (address)"];

async function main() {
  const env = getUsdcLpEnv();
  const [deployer] = await ethers.getSigners();
  const lp = await getUsdcLpSigner();

  if (!lp) {
    throw new Error("USDC_LP_PRIVATE_KEY nao configurada no .env.usdc");
  }

  const lockOwner = env.LOCK_OWNER_ADDRESS;
  const lockDurationSeconds = BigInt(env.LOCK_DURATION_DAYS) * 864n;

  console.log(`[21] Lock de LP tokens CAS/USDC em ${env.DEX_ROUTERS.length} DEXs`);
  console.log(`  Lock owner : ${lockOwner}`);

  for (const dex of env.DEX_ROUTERS) {
    const router = await ethers.getContractAt(["function factory() view returns (address)"], dex.address);
    const factoryAddr = await router.factory();
    const factory = await ethers.getContractAt(FACTORY_ABI, factoryAddr);
    const pairAddr = await factory.getPair(env.CAS_TOKEN_ADDRESS, env.USDC_TOKEN_ADDRESS);
    const lpToken = await getErc20Contract(pairAddr);
    const balance = await lpToken.balanceOf(env.USDC_LP_ADDRESS);

    if (balance === 0n) {
      console.log(`  ${dex.name}: sem LP tokens, pulando.`);
      continue;
    }

    const LiquidityLock = await ethers.getContractFactory("LiquidityLock");
    const lock = await LiquidityLock.connect(deployer).deploy(pairAddr, lockDurationSeconds, lockOwner);
    await lock.waitForDeployment();
    const lockAddr = await lock.getAddress();

    const tx = await lpToken.connect(lp).transfer(lockAddr, balance);
    await tx.wait();

    const locked = await lpToken.balanceOf(lockAddr);
    const unlockTime = await lock.unlockTime();

    console.log(`\n  ${dex.name}`);
    console.log(`    Lock address : ${lockAddr}`);
    console.log(`    LP token     : ${pairAddr}`);
    console.log(`    LP locked    : ${locked.toString()}`);
    console.log(`    Unlock time  : ${new Date(Number(unlockTime) * 1000).toISOString()}`);
  }

  console.log(`\n[21] Lock concluido.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
