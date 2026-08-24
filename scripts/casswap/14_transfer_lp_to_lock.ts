import "dotenv/config";
import { ethers } from "hardhat";
import { requireEnv, sendAndVerify, SEP } from "../utils/deploy_helpers";

const LP_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
];

const DEX_PAIRS = [
  { name: "QuickSwap", env: "QUICKSWAP_LP_TOKEN_ADDRESS" },
  { name: "SushiSwap", env: "SUSHISWAP_LP_TOKEN_ADDRESS" },
  { name: "ApeSwap", env: "APESWAP_LP_TOKEN_ADDRESS" },
  { name: "Dfyn", env: "DFYN_LP_TOKEN_ADDRESS" },
];

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const env = requireEnv(["LP_LOCK_ADDRESS"]);
  const lockAddr = env.LP_LOCK_ADDRESS;

  console.log(`\n${SEP}`);
  console.log("  Resgate de LP tokens dos DEXs para Liquidity Lock");
  console.log(SEP);
  console.log(`  Lock wallet : ${lockAddr}`);
  console.log(`  Deployer    : ${deployer.address}\n`);

  const feeData = await ethers.provider.getFeeData();
  const latestBlock = await ethers.provider.getBlock("latest");
  const baseFee = latestBlock?.baseFeePerGas ?? 0n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? 25_000_000_000n;
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
  const txOptions = { maxFeePerGas, maxPriorityFeePerGas };
  const displayGasPrice = maxFeePerGas;

  console.log(`  Base fee atual: ${ethers.formatUnits(baseFee, "gwei")} gwei`);
  console.log(`  Max fee per gas: ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei\n`);

  let totalTransferred = 0n;

  for (const dex of DEX_PAIRS) {
    const pairAddr = process.env[dex.env];
    if (!pairAddr || !ethers.isAddress(pairAddr)) {
      console.log(`  ${dex.name}: endereco nao configurado — pulando.`);
      continue;
    }

    const lp = new ethers.Contract(pairAddr, LP_ABI, deployer);
    const balance = await lp.balanceOf(deployer.address);

    if (balance === 0n) {
      console.log(`  ${dex.name}: nenhum LP token no deployer — pulando.`);
      continue;
    }

    let symbol = "";
    try {
      symbol = await lp.symbol();
    } catch {
      // ignore
    }

    console.log(`  ${dex.name}: ${ethers.formatEther(balance)} ${symbol || "LP"} em ${pairAddr}`);

    await sendAndVerify(
      `${dex.name} transfer(${ethers.formatEther(balance)} LP) -> ${lockAddr}`,
      lp.transfer(lockAddr, balance, txOptions),
      displayGasPrice,
    );

    totalTransferred += balance;
    console.log(`  ${dex.name}: transferido com sucesso.\n`);
  }

  console.log(`\n${SEP}`);
  console.log("  Resumo do resgate para Liquidity Lock");
  console.log(SEP);
  console.log(`  Lock wallet: ${lockAddr}`);
  console.log(`  Total LP transferido: ${ethers.formatEther(totalTransferred)} LP tokens`);
  console.log(`  DEXs processados: ${DEX_PAIRS.map((d) => d.name).join(", ")}`);
  console.log(`\n${SEP}\n`);
}

main().catch((err) => {
  console.error(`\n  Erro: ${err.message ?? err}`);
  process.exit(1);
});
