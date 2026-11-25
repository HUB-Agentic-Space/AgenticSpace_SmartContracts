import { readFileSync, writeFileSync } from "node:fs";
import { artifacts, ethers } from "hardhat";
import { Contract, ContractFactory, getAddress, getCreateAddress, Interface, keccak256, ZeroAddress } from "ethers";
import { CAS, FACTORY, FACTORY_CODE_HASH, inventory, KEY_TYPE, MANAGER, mineHook, poolId, STATE_VIEW } from "./pools";

// A Interface sabe transformar a chave do pool e o preço nos bytes da chamada initialize.
// Snapshot deriva o tipo do resultado de inventory, depois que a Promise é resolvida por await.
const managerABI = new Interface(["function initialize(" + KEY_TYPE + " key,uint160 sqrtPriceX96) returns (int24)"]);
type Snapshot = Awaited<ReturnType<typeof inventory>>;

// Prepara endereços e dados de transação que a pessoa responsável poderá conferir antes de assinar.
export async function buildPlan(snapshot: Snapshot, initializer: string) {
  // O endereço informado pode ser uma carteira individual ou uma Safe. O hook vai aceitar somente
  // chamadas de inicialização que essa carteira fizer ao manager. O endereço zero não pode assinar.
  initializer = getAddress(initializer);
  if (initializer === ZeroAddress) throw new Error("Inicializador zero.");
  const artifact = await artifacts.readArtifact("CASInstallmentHook");
  // O artefato do compilador contém a ABI e o bytecode de criação. A ContractFactory do ethers
  // usa ambos para montar o initCode localmente. getDeployTransaction ainda não transmite nada.
  const factory = new ContractFactory(artifact.abi, artifact.bytecode);
  const sourceIds = snapshot.pools.map(p => p.id);
  const init = await factory.getDeployTransaction(MANAGER, CAS, initializer, sourceIds);
  // O endereço depende desse initCode. Nesta compilação, o Solidity inclui um hash de metadados
  // ligado aos arquivos-fonte. Até editar um comentário pode mudar o hash e o endereço CREATE2.
  // Por isso, um plano gerado antes da recompilação precisa ser gerado e conferido novamente.
  const { hook, data } = mineHook(init.data);
  return {
    chainId: 137, block: snapshot.block, blockHash: snapshot.blockHash, initializer, hook,
    // O construtor do hook cria seu roteador com new (CREATE). É a primeira criação feita pelo
    // contrato recém-criado, com nonce 1. Aqui o endereço depende do hook e desse nonce.
    router: getCreateAddress({ from: hook, nonce: 1 }), deploy: { to: FACTORY, data },
    pools: snapshot.pools.map(p => {
      // Copiar a chave e trocar hooks gera outro PoolId para o mesmo par. A chamada de initialize
      // define o preço do novo pool. Os provedores de liquidez decidem quanto depositar em seguida.
      const key = { ...p.key, hooks: hook };
      return { symbol: p.symbol, sourceId: p.id, id: poolId(key), key, sqrtPriceX96: p.sqrtPriceX96,
        initialize: { to: MANAGER, data: managerABI.encodeFunctionData("initialize", [key, p.sqrtPriceX96]) } };
    }),
  };
}

type Plan = Awaited<ReturnType<typeof buildPlan>>;

export async function main() {
  const provider = ethers.provider;
  // O modo padrão só lê o estado dos cinco pools. O operador escolhe explicitamente as etapas
  // que gravam o plano em disco, implantam os contratos ou inicializam os pools.
  const action = process.env.CAS_V4_ACTION ?? "inspect";
  const snapshot = await inventory(provider);
  console.log("Polygon PoS, bloco", snapshot.block, snapshot.blockHash);
  console.table(snapshot.pools.map(({symbol, id, sqrtPriceX96, activeLiquidity}) => ({symbol, id, sqrtPriceX96, activeLiquidity})));
  if (action === "inspect") return;
  if (!["plan", "deploy", "initialize"].includes(action)) throw new Error("Ação inválida.");
  // Confirmamos o código em execução na factory. Conhecer só o endereço não comprova qual
  // contrato está ali, especialmente em um fork ou em uma rede configurada por engano.
  if (keccak256(await provider.getCode(FACTORY)) !== FACTORY_CODE_HASH) throw new Error("Factory CREATE2 divergente.");
  const filename = process.env.CAS_V4_PLAN ?? "cas-v4-plan.json";
  if (action === "plan") {
    if (!process.env.CAS_V4_INITIALIZER) throw new Error("Defina CAS_V4_INITIALIZER (EOA ou Safe que inicializará os pools).");
    const plan = await buildPlan(snapshot, process.env.CAS_V4_INITIALIZER);
    // "wx" cria o arquivo apenas se ele ainda não existir. Isso preserva o plano já revisado.
    // O JSON guarda endereços, preços e calldata pública. Nenhuma chave privada é necessária aqui.
    writeFileSync(filename, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
    console.log("Plano salvo:", filename, "hook:", plan.hook, "router:", plan.router);
    return;
  }

  const reviewed: Plan = JSON.parse(readFileSync(filename, "utf8"));
  // A etapa de execução lê o arquivo já revisado. Retomamos o bloco e os preços nele registrados
  // e usamos as identidades dos pools conferidas agora. Assim um novo preço RPC não substitui
  // silenciosamente o preço que a carteira pretende usar para initialize.
  if (reviewed.pools.length !== snapshot.pools.length) throw new Error("Lista de pools divergente.");
  const plannedSnapshot = { ...snapshot, block: reviewed.block, blockHash: reviewed.blockHash,
    pools: snapshot.pools.map((p, i) => ({ ...p, sqrtPriceX96: reviewed.pools[i].sqrtPriceX96 })) };
  const plan = await buildPlan(plannedSnapshot, reviewed.initializer);
  // A comparação inclui IDs, endereços e cada chamada codificada. Confere que o plano é
  // reproduzível com os artefatos locais. A escolha do inicializador e dos preços exige revisão.
  if (JSON.stringify(plan) !== JSON.stringify(reviewed)) throw new Error("Plano não corresponde ao bytecode e às chaves locais.");
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("Configure o assinante Polygon ou use o calldata do plano via Safe.");
  if (await provider.getCode(plan.hook) === "0x") {
    // Sem código no endereço previsto, a implantação ainda é necessária. eth_call simula a
    // transação com o mesmo remetente. sendTransaction a transmite e wait aguarda o recibo.
    if (action !== "deploy") throw new Error("Execute primeiro a etapa de deploy.");
    await provider.call({ ...plan.deploy, from: signer.address });
    const tx = await signer.sendTransaction(plan.deploy);
    console.log("Deploy:", tx.hash);
    await tx.wait();
  }
  // Também chegamos aqui se já houver código no endereço do plano. Nas duas situações,
  // lemos as referências imutáveis do hook e verificamos a presença do código do roteador.
  const hook = new Contract(plan.hook, (await artifacts.readArtifact("CASInstallmentHook")).abi, provider);
  const [manager, cas, router, initializer, routerCode] = await Promise.all([
    hook.manager(), hook.cas(), hook.router(), hook.initializer(), provider.getCode(plan.router),
  ]);
  if (manager !== MANAGER || cas !== CAS || router !== plan.router || initializer !== plan.initializer ||
      routerCode === "0x") throw new Error("Implantação inconsistente.");
  console.log("Hook:", plan.hook, "router:", plan.router);
  if (action === "deploy") return;
  // Quem paga o deploy pode ser diferente de quem inicializa. Se o segundo endereço for uma
  // Safe, a própria Safe precisa chamar o manager com o calldata de initialize salvo no plano.
  if (signer.address !== initializer) throw new Error("A inicialização requer a carteira indicada no plano.");
  const state = new Contract(STATE_VIEW, ["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)"], provider);
  for (const pool of plan.pools) {
    // Os cinco pools são inicializados em transações distintas. Um sqrtPriceX96 diferente de
    // zero permite pular uma etapa já concluída e retomar a execução a partir das pendentes.
    if ((await state.getSlot0(pool.id))[0] !== 0n) {
      console.log("Pool já inicializado:", pool.symbol, pool.id);
      continue;
    }
    // Entre a simulação e a inclusão no bloco, o pool de origem pode receber outro swap.
    // beforeInitialize confere o preço dentro da própria transação e reverte se ele tiver mudado.
    await provider.call({ ...pool.initialize, from: signer.address });
    const tx = await signer.sendTransaction(pool.initialize);
    console.log("Inicializando:", pool.symbol, tx.hash);
    await tx.wait();
    // Um preço gravado no novo ID confirma a inicialização. A liquidez ainda requer um depósito.
    if ((await state.getSlot0(pool.id))[0] === 0n) throw new Error("Pool sem preço após initialize.");
  }
}

// Executar este arquivo inicia o programa. Importá-lo no teste apenas disponibiliza main e
// buildPlan, permitindo que o teste escolha a etapa e examine o resultado de cada execução.
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
