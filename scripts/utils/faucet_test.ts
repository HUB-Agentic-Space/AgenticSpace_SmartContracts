import { ethers, run } from "hardhat";

/**
 * Script de teste completo do Faucet na Polygon Amoy.
 *
 * Passos:
 *   0. (opcional) Ajusta o amount do faucet
 *   1. Envia POL para o contrato Faucet (fund it)
 *   2. Verifica o contrato no Polygonscan
 *   3. Chama requestTokens() como um usuário comum
 *
 * Variáveis de ambiente:
 *   FAUCET_ADDRESS          — endereço do Faucet deployado (obrigatório)
 *   FAUCET_TESTER_PRIVATE_KEY — chave privada da carteira que receberá os tokens (opcional, default: wallet aleatória)
 *   FAUCET_FUND_AMOUNT      — quantidade de POL a enviar (default: 0.5 POL)
 *   FAUCET_SET_AMOUNT       — se definido, ajusta o amount do faucet antes do teste (em POL)
 *   FAUCET_GAS_FUND         — POL enviada para o tester pagar gas (default: 0.001 POL)
 *
 * Uso:
 *   FAUCET_ADDRESS=0x... FAUCET_TESTER_PRIVATE_KEY=0x... npx hardhat run scripts/utils/faucet_test.ts --network polygonAmoy
 */

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

interface ErrorInfo {
  code: string;
  message: string;
  detail: string;
}

function parseError(error: unknown): ErrorInfo {
  const err = error as any;
  const rawMessage = err?.message || String(error);
  const detail = err?.reason || err?.shortMessage || "";

  if (rawMessage.includes("insufficient funds")) {
    const balanceMatch = rawMessage.match(/balance (\d+)/);
    const costMatch = rawMessage.match(/tx cost (\d+)/);
    const balance = balanceMatch ? ethers.formatEther(BigInt(balanceMatch[1])) : "?";
    const cost = costMatch ? ethers.formatEther(BigInt(costMatch[1])) : "?";
    return {
      code: "INSUFFICIENT_FUNDS",
      message: "Saldo insuficiente para pagar gas + value da transação",
      detail: `Saldo: ${balance} POL | Custo estimado: ${cost} POL`,
    };
  }

  if (rawMessage.includes("transaction gas price below minimum")) {
    const minMatch = rawMessage.match(/minimum needed (\d+)/);
    const minGwei = minMatch ? Number(BigInt(minMatch[1])) / 1e9 : "?";
    return {
      code: "GAS_PRICE_TOO_LOW",
      message: "Gas price configurado abaixo do mínimo da rede",
      detail: `Mínimo necessário: ${minGwei} Gwei. Verifique gasPrice no hardhat.config.ts`,
    };
  }

  if (rawMessage.includes("Already Verified")) {
    return {
      code: "ALREADY_VERIFIED",
      message: "Contrato já verificado no Polygonscan",
      detail: "",
    };
  }

  if (rawMessage.includes("CooldownNotElapsed")) {
    return {
      code: "COOLDOWN_ACTIVE",
      message: "Cooldown ainda ativo para este endereço",
      detail: "Aguarde o intervalo configurado antes de novo saque",
    };
  }

  if (rawMessage.includes("Blacklisted")) {
    return {
      code: "BLACKLISTED",
      message: "Endereço bloqueado na blacklist do faucet",
      detail: "Use setBlacklist(addr, false) para desbloquear",
    };
  }

  if (rawMessage.includes("InsufficientFunds")) {
    return {
      code: "FAUCET_EMPTY",
      message: "Faucet sem saldo suficiente para o saque",
      detail: "Envie mais POL para o contrato do faucet",
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    message: rawMessage.split("\n")[0].substring(0, 120),
    detail: detail || "",
  };
}

function logError(step: string, info: ErrorInfo): void {
  console.error(`\n[ERRO] ${step}`);
  console.error(`  Código:   ${info.code}`);
  console.error(`  Mensagem: ${info.message}`);
  if (info.detail) console.error(`  Detalhe:  ${info.detail}`);
}

function logStep(title: string): void {
  console.log(`\n--- ${title} ---`);
}

function logSuccess(msg: string): void {
  console.log(`  OK | ${msg}`);
}

function logInfo(msg: string): void {
  console.log(`     | ${msg}`);
}

const SEP = "=".repeat(60);
const FAUCET_URL = "https://faucet.polygon.technology/";

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main() {
  const faucetAddress = process.env.FAUCET_ADDRESS;
  if (!faucetAddress) {
    logError("Configuração", {
      code: "MISSING_ENV",
      message: "FAUCET_ADDRESS não definido",
      detail: "Defina FAUCET_ADDRESS no .env ou passe como variável de ambiente",
    });
    process.exitCode = 1;
    return;
  }

  const fundAmount = ethers.parseEther(
    process.env.FAUCET_FUND_AMOUNT || "0.5"
  );
  const gasFund = ethers.parseEther(
    process.env.FAUCET_GAS_FUND || "0.001"
  );

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    logError("Configuração", {
      code: "NO_SIGNER",
      message: "Nenhuma conta configurada para a rede",
      detail: "Verifique POLYGON_AMOY_PRIVATE_KEY no .env",
    });
    process.exitCode = 1;
    return;
  }

  // Usar chave privada informada ou gerar wallet aleatória como tester
  let tester: ethers.Wallet;
  if (process.env.FAUCET_TESTER_PRIVATE_KEY) {
    tester = new ethers.Wallet(process.env.FAUCET_TESTER_PRIVATE_KEY, ethers.provider);
  } else {
    tester = ethers.Wallet.createRandom(ethers.provider);
  }

  // Conectar ao contrato
  const Faucet = await ethers.getContractFactory("Faucet");
  const faucet = Faucet.attach(faucetAddress);

  // Estado atual do faucet
  let currentInterval: bigint;
  let currentAmount: bigint;
  try {
    currentInterval = await faucet.interval();
    currentAmount = await faucet.amount();
  } catch (error) {
    logError("Leitura do contrato", parseError(error));
    process.exitCode = 1;
    return;
  }

  // Saldo do deployer
  let deployerBalance: bigint;
  try {
    deployerBalance = await ethers.provider.getBalance(deployer.address);
  } catch (error) {
    logError("Consulta de saldo", parseError(error));
    process.exitCode = 1;
    return;
  }

  // Estimar gas price da rede
  let gasPrice: bigint;
  try {
    gasPrice = (await ethers.provider.getFeeData()).gasPrice || 25000000000n;
  } catch {
    gasPrice = 25000000000n;
  }

  // Custo estimado de gas por tx simples (~21000) e por tx de contrato (~50000)
  const simpleTxCost = 21000n * gasPrice;
  const contractTxCost = 50000n * gasPrice;

  // Total estimado necessário
  let estimatedNeeded = 0n;
  if (process.env.FAUCET_SET_AMOUNT) estimatedNeeded += contractTxCost;
  estimatedNeeded += simpleTxCost + fundAmount; // Passo 1: fund
  estimatedNeeded += simpleTxCost + gasFund;    // Passo 3: gas para tester

  console.log(SEP);
  console.log("Faucet Test — Polygon Amoy");
  console.log(SEP);
  logInfo(`Faucet address:  ${faucetAddress}`);
  logInfo(`Deployer/Owner:  ${deployer.address}`);
  logInfo(`Tester (random): ${tester.address}`);
  logInfo(`Saldo deployer:  ${ethers.formatEther(deployerBalance)} POL`);
  logInfo(`Gas price:       ${Number(gasPrice) / 1e9} Gwei`);
  logInfo(`Amount atual:    ${ethers.formatEther(currentAmount)} POL`);
  logInfo(`Interval atual:  ${currentInterval.toString()}s`);
  logInfo(`Fund amount:     ${ethers.formatEther(fundAmount)} POL`);
  logInfo(`Gas fund:        ${ethers.formatEther(gasFund)} POL`);
  logInfo(`Custo estimado:  ${ethers.formatEther(estimatedNeeded)} POL (total)`);
  console.log(SEP);

  // Verificação prévia de saldo
  if (deployerBalance < estimatedNeeded) {
    const deficit = estimatedNeeded - deployerBalance;
    logError("Saldo insuficiente", {
      code: "INSUFFICIENT_FUNDS",
      message: `Necessário ~${ethers.formatEther(estimatedNeeded)} POL, disponível ${ethers.formatEther(deployerBalance)} POL`,
      detail: `Déficit: ~${ethers.formatEther(deficit)} POL. Obtenha mais POL em: ${FAUCET_URL}`,
    });
    process.exitCode = 1;
    return;
  }

  // -----------------------------------------------------------------------
  // Passo 0 — Ajustar amount (opcional)
  // -----------------------------------------------------------------------

  if (process.env.FAUCET_SET_AMOUNT) {
    const newAmount = ethers.parseEther(process.env.FAUCET_SET_AMOUNT);
    logStep("Passo 0: Ajustando amount do faucet");
    logInfo(`Novo amount: ${ethers.formatEther(newAmount)} POL`);

    try {
      const tx = await faucet.setAmount(newAmount);
      await tx.wait();
      currentAmount = newAmount;
      logSuccess(`Amount atualizado | Tx: ${tx.hash}`);
    } catch (error) {
      logError("Passo 0 — setAmount", parseError(error));
      process.exitCode = 1;
      return;
    }
  }

  // -----------------------------------------------------------------------
  // Passo 1 — Enviar POL para o Faucet
  // -----------------------------------------------------------------------

  logStep("Passo 1: Enviando POL para o Faucet");
  logInfo(`Valor: ${ethers.formatEther(fundAmount)} POL`);

  try {
    const tx = await deployer.sendTransaction({
      to: faucetAddress,
      value: fundAmount,
    });
    await tx.wait();
    logSuccess(`POL enviado | Tx: ${tx.hash}`);
  } catch (error) {
    logError("Passo 1 — Fund faucet", parseError(error));
    process.exitCode = 1;
    return;
  }

  let faucetBalance: bigint;
  try {
    faucetBalance = await ethers.provider.getBalance(faucetAddress);
    logInfo(`Saldo do Faucet: ${ethers.formatEther(faucetBalance)} POL`);
  } catch (error) {
    logError("Passo 1 — Consultar saldo faucet", parseError(error));
    process.exitCode = 1;
    return;
  }

  // Verificar se o faucet tem saldo suficiente para o requestTokens
  if (faucetBalance < currentAmount) {
    logError("Passo 1 — Validação", {
      code: "FAUCET_EMPTY",
      message: `Faucet com ${ethers.formatEther(faucetBalance)} POL, mas amount é ${ethers.formatEther(currentAmount)} POL`,
      detail: `Aumente FAUCET_FUND_AMOUNT ou reduza FAUCET_SET_AMOUNT`,
    });
    process.exitCode = 1;
    return;
  }

  // -----------------------------------------------------------------------
  // Passo 2 — Verificar no Polygonscan
  // -----------------------------------------------------------------------

  logStep("Passo 2: Verificando contrato no Polygonscan");

  try {
    await run("verify:verify", {
      address: faucetAddress,
      constructorArguments: [currentInterval, currentAmount],
    });
    logSuccess("Contrato verificado no Polygonscan");
  } catch (error) {
    const info = parseError(error);
    if (info.code === "ALREADY_VERIFIED") {
      logSuccess("Contrato já verificado anteriormente");
    } else {
      logError("Passo 2 — Verificação (não bloqueante)", info);
    }
  }

  const chainId = (await ethers.provider.getNetwork()).chainId;
  const explorerUrl =
    chainId === 80002n
      ? `https://www.oklink.com/amoy/address/${faucetAddress}`
      : `https://polygonscan.com/address/${faucetAddress}`;
  logInfo(`Explorer: ${explorerUrl}`);

  // -----------------------------------------------------------------------
  // Passo 3 — requestTokens() como usuário comum
  // -----------------------------------------------------------------------

  logStep("Passo 3: requestTokens() como usuário comum");
  logInfo(`Enviando ${ethers.formatEther(gasFund)} POL para tester (gas)`);

  try {
    const tx = await deployer.sendTransaction({
      to: tester.address,
      value: gasFund,
    });
    await tx.wait();
    logSuccess(`Gas fund enviado | Tx: ${tx.hash}`);
  } catch (error) {
    logError("Passo 3 — Gas fund para tester", parseError(error));
    process.exitCode = 1;
    return;
  }

  const testerBalanceBefore = await ethers.provider.getBalance(tester.address);
  logInfo(`Saldo tester antes: ${ethers.formatEther(testerBalanceBefore)} POL`);

  try {
    const tx = await faucet.connect(tester).requestTokens();
    const receipt = await tx.wait();
    logSuccess(`requestTokens() executado | Tx: ${tx.hash}`);
    logInfo(`Gas usado: ${receipt?.gasUsed.toString()}`);
  } catch (error) {
    logError("Passo 3 — requestTokens()", parseError(error));
    process.exitCode = 1;
    return;
  }

  const testerBalanceAfter = await ethers.provider.getBalance(tester.address);
  const received = testerBalanceAfter - testerBalanceBefore;
  const nextTry = await faucet.nextTry(tester.address);

  logInfo(`Saldo tester depois: ${ethers.formatEther(testerBalanceAfter)} POL`);
  logInfo(`POL líquido:         ${ethers.formatEther(received)} POL`);
  logInfo(`Próximo saque:       timestamp ${nextTry.toString()}`);

  // -----------------------------------------------------------------------
  // Resumo
  // -----------------------------------------------------------------------

  const finalBalance = await ethers.provider.getBalance(faucetAddress);

  console.log(`\n${SEP}`);
  console.log("Resumo do Teste do Faucet");
  console.log(SEP);
  logInfo(`Contrato:     ${faucetAddress}`);
  logInfo(`Saldo final:  ${ethers.formatEther(finalBalance)} POL`);
  logInfo(`Interval:     ${currentInterval.toString()} segundos`);
  logInfo(`Amount:       ${ethers.formatEther(currentAmount)} POL`);
  logInfo(`Tester:       ${tester.address}`);
  logInfo(`Next try:     ${nextTry.toString()}`);
  console.log(SEP);
  console.log("\nFaucet funcionando corretamente!");
}

main().catch((error) => {
  const info = parseError(error);
  logError("Erro fatal", info);
  process.exitCode = 1;
});
