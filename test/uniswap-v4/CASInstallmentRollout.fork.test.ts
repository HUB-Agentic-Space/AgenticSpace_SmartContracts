import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers, network } from "hardhat";
import { main } from "../../scripts/uniswap-v4/installments";
import { CAS, MANAGER, STATE_VIEW } from "../../scripts/uniswap-v4/pools";

// Um fork usa o estado da Polygon como ponto de partida e executa as transações no Hardhat
// local. A suíte só roda se essa rede e um RPC de origem estiverem configurados.
const fork = network.name === "hardhat" && process.env.HARDHAT_FORK_URL ? describe : describe.skip;

fork("CASInstallmentHook / rollout no fork local da Polygon", function () {
  this.timeout(180_000);
  it("planeja, implanta, inicializa os cinco sucessores e repete as etapas sem novas transações", async function () {
    // Guardamos o estado inicial da EVM, reservamos uma pasta exclusiva para o plano e salvamos
    // o ambiente do processo. O bloco finally desfaz os três tipos de alteração ao terminar.
    const snapshotId = await network.provider.send("evm_snapshot");
    const folder = mkdtempSync(join(tmpdir(), "cas-v4-fork-"));
    const filename = join(folder, "plan.json");
    const saved = ["CAS_V4_ACTION", "CAS_V4_INITIALIZER", "CAS_V4_PLAN"].map(key => [key, process.env[key]] as const);
    try {
      // O inventário fixa suas consultas em um número de bloco. Minar um bloco no Hardhat dá
      // a ele uma altura local, na qual o simulador usa as regras de EVM configuradas para o fork.
      await network.provider.send("evm_mine");
      const [signer] = await ethers.getSigners();
      process.env.CAS_V4_INITIALIZER = signer.address;
      process.env.CAS_V4_PLAN = filename;
      // Chamamos a mesma main usada na linha de comando. plan escreve o JSON, deploy cria hook
      // e roteador, initialize envia as cinco inicializações. O assinante é uma conta local de teste.
      for (const stage of ["plan", "deploy", "initialize"]) {
        process.env.CAS_V4_ACTION = stage;
        await main();
      }
      const plan = JSON.parse(readFileSync(filename, "utf8"));
      const hook = await ethers.getContractAt("CASInstallmentHook", plan.hook);
      // Ler as referências imutáveis do contrato implantado confere que ele se vinculou ao manager
      // e ao token CAS que já existem no estado copiado da Polygon.
      expect(await hook.manager()).to.equal(MANAGER);
      expect(await hook.cas()).to.equal(CAS);
      const state = new ethers.Contract(STATE_VIEW, [
        "function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)",
        "function getLiquidity(bytes32) view returns(uint128)",
      ], ethers.provider);
      expect(plan.pools).to.have.length(5);
      for (const pool of plan.pools) {
        // Cada origem e seu sucessor têm IDs distintos. A origem precisa constar na lista do hook,
        // e o preço do sucessor precisa ser o do plano. A liquidez começa em zero porque nenhuma
        // posição foi depositada. Inicializar um pool e financiar uma posição são operações separadas.
        expect(pool.sourceId).not.to.equal(pool.id);
        expect(await hook.sourceAllowed(pool.sourceId)).to.equal(true);
        expect((await state.getSlot0(pool.id))[0]).to.equal(BigInt(pool.sqrtPriceX96));
        expect(await state.getLiquidity(pool.id)).to.equal(0n);
      }
      // O nonce da conta aumenta quando ela envia uma transação. Repetir as duas etapas e obter
      // o mesmo nonce demonstra que o script reconheceu o trabalho concluído sem reenviá-lo.
      const nonce = await signer.getNonce();
      for (const stage of ["deploy", "initialize"]) {
        process.env.CAS_V4_ACTION = stage;
        await main();
      }
      expect(await signer.getNonce()).to.equal(nonce);
    } finally {
      // Restaurar inclusive as variáveis originalmente ausentes impede que uma suíte posterior
      // herde o plano ou o inicializador. evm_revert restaura o estado do fork ao snapshot.
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(folder, { recursive: true, force: true });
      await network.provider.send("evm_revert", [snapshotId]);
    }
  });
});
