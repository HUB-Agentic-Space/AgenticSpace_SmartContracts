import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers, network } from "hardhat";
import { main } from "../../scripts/uniswap-v4/installments";
import { CAS, MANAGER, STATE_VIEW } from "../../scripts/uniswap-v4/pools";

const fork = network.name === "hardhat" && process.env.HARDHAT_FORK_URL ? describe : describe.skip;

fork("CASInstallmentHook / rollout no fork local da Polygon", function () {
  this.timeout(180_000);
  it("planeja, implanta, inicializa os cinco sucessores e repete as etapas sem novas transações", async function () {
    const snapshotId = await network.provider.send("evm_snapshot");
    const folder = mkdtempSync(join(tmpdir(), "cas-v4-fork-"));
    const filename = join(folder, "plan.json");
    const saved = ["CAS_V4_ACTION", "CAS_V4_INITIALIZER", "CAS_V4_PLAN"].map(key => [key, process.env[key]] as const);
    try {
      // Pin inventory reads to a locally mined block so EDR uses the fork's configured EVM.
      await network.provider.send("evm_mine");
      const [signer] = await ethers.getSigners();
      process.env.CAS_V4_INITIALIZER = signer.address;
      process.env.CAS_V4_PLAN = filename;
      for (const stage of ["plan", "deploy", "initialize"]) {
        process.env.CAS_V4_ACTION = stage;
        await main();
      }
      const plan = JSON.parse(readFileSync(filename, "utf8"));
      const hook = await ethers.getContractAt("CASInstallmentHook", plan.hook);
      expect(await hook.manager()).to.equal(MANAGER);
      expect(await hook.cas()).to.equal(CAS);
      const state = new ethers.Contract(STATE_VIEW, [
        "function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)",
        "function getLiquidity(bytes32) view returns(uint128)",
      ], ethers.provider);
      expect(plan.pools).to.have.length(5);
      for (const pool of plan.pools) {
        expect(pool.sourceId).not.to.equal(pool.id);
        expect(await hook.sourceAllowed(pool.sourceId)).to.equal(true);
        expect((await state.getSlot0(pool.id))[0]).to.equal(BigInt(pool.sqrtPriceX96));
        expect(await state.getLiquidity(pool.id)).to.equal(0n);
      }
      const nonce = await signer.getNonce();
      for (const stage of ["deploy", "initialize"]) {
        process.env.CAS_V4_ACTION = stage;
        await main();
      }
      expect(await signer.getNonce()).to.equal(nonce);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(folder, { recursive: true, force: true });
      await network.provider.send("evm_revert", [snapshotId]);
    }
  });
});
