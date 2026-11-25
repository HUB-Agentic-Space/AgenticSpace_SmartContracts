import { readFileSync, writeFileSync } from "node:fs";
import { artifacts, ethers } from "hardhat";
import { Contract, ContractFactory, getAddress, getCreateAddress, Interface, keccak256, ZeroAddress } from "ethers";
import { CAS, FACTORY, FACTORY_CODE_HASH, inventory, KEY_TYPE, MANAGER, mineHook, poolId, STATE_VIEW } from "./pools";

const managerABI = new Interface(["function initialize(" + KEY_TYPE + " key,uint160 sqrtPriceX96) returns (int24)"]);
type Snapshot = Awaited<ReturnType<typeof inventory>>;

export async function buildPlan(snapshot: Snapshot, initializer: string) {
  initializer = getAddress(initializer);
  if (initializer === ZeroAddress) throw new Error("Inicializador zero.");
  const artifact = await artifacts.readArtifact("CASInstallmentHook");
  const factory = new ContractFactory(artifact.abi, artifact.bytecode);
  const sourceIds = snapshot.pools.map(p => p.id);
  const init = await factory.getDeployTransaction(MANAGER, CAS, initializer, sourceIds);
  const { hook, data } = mineHook(init.data);
  return {
    chainId: 137, block: snapshot.block, blockHash: snapshot.blockHash, initializer, hook,
    router: getCreateAddress({ from: hook, nonce: 1 }), deploy: { to: FACTORY, data },
    pools: snapshot.pools.map(p => {
      const key = { ...p.key, hooks: hook };
      return { symbol: p.symbol, sourceId: p.id, id: poolId(key), key, sqrtPriceX96: p.sqrtPriceX96,
        initialize: { to: MANAGER, data: managerABI.encodeFunctionData("initialize", [key, p.sqrtPriceX96]) } };
    }),
  };
}

type Plan = Awaited<ReturnType<typeof buildPlan>>;

export async function main() {
  const provider = ethers.provider;
  const action = process.env.CAS_V4_ACTION ?? "inspect";
  const snapshot = await inventory(provider);
  console.log("Polygon PoS, bloco", snapshot.block, snapshot.blockHash);
  console.table(snapshot.pools.map(({symbol, id, sqrtPriceX96, activeLiquidity}) => ({symbol, id, sqrtPriceX96, activeLiquidity})));
  if (action === "inspect") return;
  if (!["plan", "deploy", "initialize"].includes(action)) throw new Error("Ação inválida.");
  if (keccak256(await provider.getCode(FACTORY)) !== FACTORY_CODE_HASH) throw new Error("Factory CREATE2 divergente.");
  const filename = process.env.CAS_V4_PLAN ?? "cas-v4-plan.json";
  if (action === "plan") {
    if (!process.env.CAS_V4_INITIALIZER) throw new Error("Defina CAS_V4_INITIALIZER (EOA ou Safe que inicializará os pools).");
    const plan = await buildPlan(snapshot, process.env.CAS_V4_INITIALIZER);
    writeFileSync(filename, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
    console.log("Plano salvo:", filename, "hook:", plan.hook, "router:", plan.router);
    return;
  }

  const reviewed: Plan = JSON.parse(readFileSync(filename, "utf8"));
  // Rebuild every address and every transaction locally; only retain the approved source prices.
  if (reviewed.pools.length !== snapshot.pools.length) throw new Error("Lista de pools divergente.");
  const plannedSnapshot = { ...snapshot, block: reviewed.block, blockHash: reviewed.blockHash,
    pools: snapshot.pools.map((p, i) => ({ ...p, sqrtPriceX96: reviewed.pools[i].sqrtPriceX96 })) };
  const plan = await buildPlan(plannedSnapshot, reviewed.initializer);
  if (JSON.stringify(plan) !== JSON.stringify(reviewed)) throw new Error("Plano não corresponde ao bytecode e às chaves locais.");
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("Configure o assinante Polygon ou use o calldata do plano via Safe.");
  if (await provider.getCode(plan.hook) === "0x") {
    if (action !== "deploy") throw new Error("Execute primeiro a etapa de deploy.");
    await provider.call({ ...plan.deploy, from: signer.address });
    const tx = await signer.sendTransaction(plan.deploy);
    console.log("Deploy:", tx.hash);
    await tx.wait();
  }
  const hook = new Contract(plan.hook, (await artifacts.readArtifact("CASInstallmentHook")).abi, provider);
  const [manager, cas, router, initializer, routerCode] = await Promise.all([
    hook.manager(), hook.cas(), hook.router(), hook.initializer(), provider.getCode(plan.router),
  ]);
  if (manager !== MANAGER || cas !== CAS || router !== plan.router || initializer !== plan.initializer ||
      routerCode === "0x") throw new Error("Implantação inconsistente.");
  console.log("Hook:", plan.hook, "router:", plan.router);
  if (action === "deploy") return;
  if (signer.address !== initializer) throw new Error("A inicialização requer a carteira indicada no plano.");
  const state = new Contract(STATE_VIEW, ["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)"], provider);
  for (const pool of plan.pools) {
    if ((await state.getSlot0(pool.id))[0] !== 0n) {
      console.log("Pool já inicializado:", pool.symbol, pool.id);
      continue;
    }
    // beforeInitialize checks the source price again inside the transaction.
    await provider.call({ ...pool.initialize, from: signer.address });
    const tx = await signer.sendTransaction(pool.initialize);
    console.log("Inicializando:", pool.symbol, tx.hash);
    await tx.wait();
    if ((await state.getSlot0(pool.id))[0] === 0n) throw new Error("Pool sem preço após initialize.");
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
