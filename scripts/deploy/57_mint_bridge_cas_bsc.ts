/**
 * @file 57_mint_bridge_cas_bsc.ts
 * @notice Mint de CAS na Polygon + bridge para a BSC via LayerZero OFT.
 * @dev    Dois passos INDEPENDENTES (podem rodar juntos ou separados):
 *
 *          1. MINT   (BRIDGE_MINT_ENABLED=true): mint de BRIDGE_MINT_AMOUNT
 *             CAS para o deployer na Polygon (requer MINTER_ROLE, respeita
 *             MAX_SUPPLY e pausa).
 *          2. BRIDGE (BRIDGE_SEND_ENABLED=true): approve no CASOFTAdapter +
 *             send() com quoteSend da fee LZ (paga em POL) -> CASOFT na BSC.
 *             Usa o saldo CAS do deployer — nao depende do passo 1.
 *
 *         Combinacoes uteis:
 *           - mint+bridge:    BRIDGE_MINT_ENABLED=true  BRIDGE_SEND_ENABLED=true
 *           - so mint:        BRIDGE_MINT_ENABLED=true  BRIDGE_SEND_ENABLED=false
 *           - so bridge:      BRIDGE_MINT_ENABLED=false BRIDGE_SEND_ENABLED=true
 *             (usa CAS ja existente na Polygon)
 *
 *         Apos o send, faz polling no LayerZero Scan ate DELIVERED e, se
 *         BSC_RPC_URL+CAS_OFT_BSC estiverem no .env, confere o saldo na BSC.
 *
 *         Uso (DRY-RUN e o padrao; execucao exige BRIDGE_EXECUTE=true):
 *           npx hardhat run scripts/deploy/57_mint_bridge_cas_bsc.ts --network polygon
 *           BRIDGE_EXECUTE=true npx hardhat run scripts/deploy/57_mint_bridge_cas_bsc.ts --network polygon
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

const FILE = "scripts/deploy/57_mint_bridge_cas_bsc.ts";

const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));

const CAS_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function paused() view returns (bool)",
];

const ADAPTER_ABI = [
  "function send((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, (uint256 nativeFee, uint256 lzTokenFee) _fee, address _refundAddress) payable returns ((bytes32 guid, uint64 nonce, (uint256 nativeFee, uint256 lzTokenFee) fee) msgReceipt, (uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)",
  "function quoteSend((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, bool _payInLzToken) view returns ((uint256 nativeFee, uint256 lzTokenFee) msgFee)",
  "function token() view returns (address)",
  "function peers(uint32 eid) view returns (bytes32)",
];

const CL_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

const LZ_SCAN_API = "https://scan.layerzero-api.com/v1/messages/tx";

// Estimativas conservadoras de gas na Polygon.
const GAS_EST = {
  mint: 150_000n,
  approve: 60_000n,
  send: 400_000n,
};

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${FILE}:main] ${level} ${message}${extra}`);
}

/**
 * Monta extraOptions (type 3) com opcao executor lzReceive(gas, value).
 * Layout: 0x0003 | workerId(1B=01) | optionSize(2B) | optionType(1B=01) | data.
 */
function lzReceiveOptions(gasLimit: bigint, msgValue = 0n): string {
  const data = ethers.solidityPacked(["uint128", "uint128"], [gasLimit, msgValue]);
  const optionSize = 1 + 32; // optionType byte + data
  return (
    "0x0003" +
    "01" +
    optionSize.toString(16).padStart(4, "0") +
    "01" +
    data.slice(2)
  );
}

async function lzScanStatus(txHash: string): Promise<{ status: string; dstTx?: string }> {
  try {
    const res = await fetch(`${LZ_SCAN_API}/${txHash}`);
    if (!res.ok) return { status: `HTTP_${res.status}` };
    const json: any = await res.json();
    const msg = json?.data?.[0];
    if (!msg) return { status: "INDEXING" };
    return {
      status: msg.status?.name ?? "UNKNOWN",
      dstTx: msg.destination?.tx?.txHash,
    };
  } catch (err: any) {
    return { status: `SCAN_ERROR(${err?.message})` };
  }
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Mint + Bridge CAS — Polygon -> BSC (LayerZero OFT)");
  console.log(SEP);

  const env = requireEnv(["CAS_TOKEN_ADDRESS", "CAS_OFT_ADAPTER_POLYGON", "LZ_EID_BSC"]);
  // Flag dedicada: nao reutiliza DRY_RUN global para evitar execucao
  // acidental na mainnet quando DRY_RUN=false ja estiver no .env.
  const dryRun = (process.env.BRIDGE_EXECUTE ?? "false").toLowerCase() !== "true";
  const mintEnabled = (process.env.BRIDGE_MINT_ENABLED ?? "true").toLowerCase() === "true";
  const sendEnabled = (process.env.BRIDGE_SEND_ENABLED ?? "true").toLowerCase() === "true";
  const mintAmount = ethers.parseEther(process.env.BRIDGE_MINT_AMOUNT ?? "500000");
  const sendAmount = ethers.parseEther(process.env.BRIDGE_CAS_AMOUNT ?? "500000");
  const lzReceiveGas = BigInt(process.env.LZ_RECEIVE_GAS ?? "200000");

  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);

  console.log(`\n${SUB}\n  Rede\n${SUB}`);
  console.log(`  Rede:    ${netInfo.name} (${chainId})`);
  console.log(`  Modo:    ${dryRun ? "DRY-RUN (nenhuma tx sera enviada)" : "EXECUCAO"}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Mint:    ${mintEnabled ? `ON (${ethers.formatEther(mintAmount)} CAS)` : "OFF"}`);
  console.log(`  Bridge:  ${sendEnabled ? `ON (${ethers.formatEther(sendAmount)} CAS -> BSC)` : "OFF"}`);

  if (chainId !== 137) {
    log("ERROR", "Abortando: script deve rodar na Polygon mainnet (137)", { chainId });
    process.exit(1);
  }
  if (!mintEnabled && !sendEnabled) {
    log("ERROR", "Nada a fazer: BRIDGE_MINT_ENABLED e BRIDGE_SEND_ENABLED estao OFF");
    process.exit(1);
  }

  const cas = new ethers.Contract(env.CAS_TOKEN_ADDRESS, CAS_ABI, deployer);
  const adapter = new ethers.Contract(env.CAS_OFT_ADAPTER_POLYGON, ADAPTER_ABI, deployer);

  // ── Checagens on-chain ─────────────────────────────────────────────
  const [paused, isMinter, casBalance, totalSupply, maxSupply, peerBsc] = await Promise.all([
    cas.paused(),
    cas.hasRole(MINTER_ROLE, deployer.address),
    cas.balanceOf(deployer.address),
    cas.totalSupply(),
    cas.maxSupply(),
    adapter.peers(Number(env.LZ_EID_BSC)),
  ]);

  console.log(`\n${SUB}\n  Estado on-chain\n${SUB}`);
  console.log(`  CAS pausado:        ${paused}`);
  console.log(`  Deployer MINTER:    ${isMinter}`);
  console.log(`  Saldo CAS deployer: ${ethers.formatEther(casBalance)}`);
  console.log(`  Supply:             ${ethers.formatEther(totalSupply)} / ${ethers.formatEther(maxSupply)}`);
  console.log(`  Peer BSC no adapter:${peerBsc}`);

  const problems: string[] = [];
  if (paused) problems.push("CASToken esta PAUSADO — mint/send vao reverter");
  if (mintEnabled && !isMinter) problems.push("deployer sem MINTER_ROLE para o mint");
  if (mintEnabled && totalSupply + mintAmount > maxSupply)
    problems.push(`mint excede MAX_SUPPLY (${ethers.formatEther(totalSupply + mintAmount)} > ${ethers.formatEther(maxSupply)})`);
  if (sendEnabled && peerBsc === ethers.ZeroHash)
    problems.push("adapter sem peer na BSC — rode scripts/deploy/56_deploy_cas_oft_bsc.ts");
  if (sendEnabled && casBalance + (mintEnabled ? mintAmount : 0n) < sendAmount)
    problems.push(`saldo CAS insuficiente para o send (${ethers.formatEther(casBalance)} + mint < ${ethers.formatEther(sendAmount)})`);

  if (problems.length > 0) {
    console.log(`\n${SUB}\n  PROBLEMAS\n${SUB}`);
    for (const p of problems) console.log(`  - ${p}`);
    if (!dryRun || problems.some((p) => !p.startsWith("saldo"))) process.exit(1);
  }

  // ── SendParam + quote da fee LZ ────────────────────────────────────
  const extraOptions = lzReceiveOptions(lzReceiveGas);
  const sendParam = {
    dstEid: Number(env.LZ_EID_BSC),
    to: ethers.zeroPadValue(deployer.address, 32),
    amountLD: sendAmount,
    minAmountLD: sendAmount, // OFTAdapter e lossless (1:1)
    extraOptions,
    composeMsg: "0x",
    oftCmd: "0x",
  };

  let nativeFee = 0n;
  if (sendEnabled) {
    const quoted = await adapter.quoteSend(sendParam, false);
    nativeFee = quoted.nativeFee;
    console.log(`\n${SUB}\n  Fee LayerZero (POL nativo)\n${SUB}`);
    console.log(`  nativeFee: ${ethers.formatEther(nativeFee)} POL`);
    console.log(`  lzTokenFee: ${ethers.formatEther(quoted.lzTokenFee)}`);
  }

  // ── Tabela de provisao ─────────────────────────────────────────────
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 30_000_000_000n;
  const gasUnits =
    (mintEnabled ? GAS_EST.mint : 0n) +
    (sendEnabled ? GAS_EST.approve + GAS_EST.send : 0n);
  const gasCost = gasUnits * gasPrice;
  const polBalance = await provider.getBalance(deployer.address);
  const polNeeded = gasCost + nativeFee;
  const polNeededPadded = (polNeeded * 120n) / 100n;
  const polMissing = polNeededPadded > polBalance ? polNeededPadded - polBalance : 0n;
  const casMissing = sendEnabled && casBalance + (mintEnabled ? mintAmount : 0n) < sendAmount
    ? sendAmount - casBalance - (mintEnabled ? mintAmount : 0n)
    : 0n;

  console.log(`\n${SEP}`);
  console.log("  TABELA DE PROVISAO — Polygon");
  console.log(SEP);
  console.log(`  ${"Item".padEnd(18)} ${"Saldo atual".padStart(18)} ${"Necessario".padStart(18)} ${"Faltante".padStart(18)}`);
  console.log(`  ${"CAS".padEnd(18)} ${ethers.formatEther(casBalance).padStart(18)} ${ethers.formatEther(sendAmount).padStart(18)} ${ethers.formatEther(casMissing).padStart(18)}`);
  console.log(`  ${"POL (gas+fee)*".padEnd(18)} ${ethers.formatEther(polBalance).padStart(18)} ${ethers.formatEther(polNeededPadded).padStart(18)} ${ethers.formatEther(polMissing).padStart(18)}`);
  console.log(`\n  *gas estimado (${gasUnits} x ${fmtGwei(gasPrice)}) + LZ fee ${ethers.formatEther(nativeFee)} + 20% margem`);
  if (mintEnabled) console.log(`  CAS "Necessario" coberto parcial/total pelo mint de ${ethers.formatEther(mintAmount)}`);

  if (dryRun) {
    console.log(`\n${SEP}`);
    console.log("  DRY-RUN concluido — nenhuma transacao enviada.");
    console.log(`  Para executar: BRIDGE_EXECUTE=true npx hardhat run ${FILE} --network polygon`);
    console.log(`${SEP}\n`);
    return;
  }

  if (problems.length > 0 || polMissing > 0n || casMissing > 0n) {
    log("ERROR", "Provisao insuficiente — resolva os itens acima antes de executar.");
    process.exit(1);
  }

  const send = async (label: string, buildTx: () => Promise<any>): Promise<any> => {
    const tx = await buildTx();
    console.log(`  TX ${label}: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      log("ERROR", `tx revertida: ${label}`, { hash: tx.hash });
      process.exit(1);
    }
    log("INFO", `confirmada ${label}`, { hash: tx.hash, gasUsed: receipt.gasUsed.toString() });
    return receipt;
  };

  // ── Passo 1: mint (opcional) ───────────────────────────────────────
  if (mintEnabled) {
    console.log(`\n${SUB}\n  Mint CAS (Polygon)\n${SUB}`);
    await send(
      `CASToken.mint(deployer, ${ethers.formatEther(mintAmount)})`,
      () => cas.mint(deployer.address, mintAmount, { gasPrice }),
    );
  }

  // ── Passo 2: approve + send ────────────────────────────────────────
  if (sendEnabled) {
    console.log(`\n${SUB}\n  Approve CAS -> OFTAdapter\n${SUB}`);
    const allowance = await cas.allowance(deployer.address, env.CAS_OFT_ADAPTER_POLYGON);
    if (allowance < sendAmount) {
      await send(
        `CAS.approve(adapter, ${ethers.formatEther(sendAmount)})`,
        () => cas.approve(env.CAS_OFT_ADAPTER_POLYGON, sendAmount, { gasPrice }),
      );
    } else {
      console.log(`  Allowance suficiente (${ethers.formatEther(allowance)})`);
    }

    console.log(`\n${SUB}\n  Bridge send -> BSC\n${SUB}`);
    const receipt = await send(
      `OFTAdapter.send(BSC, ${ethers.formatEther(sendAmount)} CAS)`,
      () => adapter.send(
        sendParam,
        { nativeFee, lzTokenFee: 0n },
        deployer.address,
        { value: nativeFee, gasPrice },
      ),
    );

    // ── Polling LayerZero Scan ───────────────────────────────────────
    console.log(`\n${SUB}\n  Aguardando entrega LayerZero\n${SUB}`);
    const txHash = receipt.hash;
    console.log(`  Track: https://layerzeroscan.com/tx/${txHash}`);
    let status = "";
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      const s = await lzScanStatus(txHash);
      status = s.status;
      console.log(`  [${(i + 1) * 10}s] status=${status}${s.dstTx ? ` dstTx=${s.dstTx}` : ""}`);
      if (status === "DELIVERED" || status === "FAILED" || status === "BLOCKED") break;
    }
    log("INFO", "resultado bridge", { txHash, status });
    if (status !== "DELIVERED") {
      console.log(`\n  AVISO: mensagem nao entregue ainda (status=${status}).`);
      console.log(`  Acompanhe em https://layerzeroscan.com/tx/${txHash}`);
    }

    // ── Saldo CASOFT na BSC (se configurado) ─────────────────────────
    const bscRpc = process.env.BSC_RPC_URL;
    const oftBsc = process.env.CAS_OFT_BSC;
    if (bscRpc && oftBsc) {
      const bscProvider = new ethers.JsonRpcProvider(bscRpc);
      const oft = new ethers.Contract(
        oftBsc,
        ["function balanceOf(address) view returns (uint256)"],
        bscProvider,
      );
      const bal = await oft.balanceOf(deployer.address);
      console.log(`\n  Saldo CASOFT na BSC: ${ethers.formatEther(bal)} CAS`);
    }
  }

  console.log(`\n${SEP}`);
  console.log("  Concluido");
  console.log(`${SEP}\n`);
}

main().catch((err) => {
  log("ERROR", "falha nao tratada", { error: String(err?.message ?? err) });
  console.error(err);
  process.exit(1);
});
