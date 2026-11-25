import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { Contract, ContractFactory, id as hashSignature, MaxUint256, parseEther, ZeroAddress, ZeroHash } from "ethers";
import { FACTORY, FACTORY_CODE_HASH, Key, mineHook, poolId } from "../../scripts/uniswap-v4/pools";

const DAY = 86_400;
const PRICE = 1n << 96n;
const LOT = parseEther("20000");
const HALF = LOT / 2n;
const FACTORY_CODE = "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

async function fixture() {
  const [lp, buyer, other] = await ethers.getSigners();
  async function deployCore(name: string, arg: string) {
    const artifact = require("@uniswap/v4-core/out/" + name + ".sol/" + name + ".json");
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode.object, lp).deploy(arg);
    await contract.waitForDeployment();
    return new Contract(await contract.getAddress(), artifact.abi, lp);
  }
  const manager = await deployCore("PoolManager", lp.address);
  const managerAddress = await manager.getAddress();
  const liquidityRouter = await deployCore("PoolModifyLiquidityTest", managerAddress);
  const tokenFactory = await ethers.getContractFactory("MockERC20");
  const tokens = [];
  for (const symbol of ["A", "B", "C"]) {
    const token = await tokenFactory.deploy(symbol, symbol, 18);
    await token.waitForDeployment();
    tokens.push(token);
  }
  tokens.sort((a, b) => String(a.target).toLowerCase().localeCompare(String(b.target).toLowerCase()));
  const [lower, cas, upper] = tokens;
  const casAddress = await cas.getAddress();
  const sources: Key[] = [
    { currency0: await lower.getAddress(), currency1: casAddress, fee: 3000, tickSpacing: 60, hooks: ZeroAddress },
    { currency0: casAddress, currency1: await upper.getAddress(), fee: 3000, tickSpacing: 60, hooks: ZeroAddress },
  ];
  for (const source of sources) await manager.initialize(source, PRICE);
  expect(ethers.keccak256(FACTORY_CODE)).to.equal(FACTORY_CODE_HASH);
  await network.provider.send("hardhat_setCode", [FACTORY, FACTORY_CODE]);
  const hookFactory = await ethers.getContractFactory("CASInstallmentHook");
  const creation = await hookFactory.getDeployTransaction(managerAddress, casAddress, lp.address, sources.map(poolId));
  const mined = mineHook(creation.data);
  await (await lp.sendTransaction({ to: FACTORY, data: mined.data })).wait();
  const hook = await ethers.getContractAt("CASInstallmentHook", mined.hook);
  const router = await ethers.getContractAt("CASInstallmentRouter", await hook.router());
  const keys = sources.map(source => ({ ...source, hooks: mined.hook }));
  for (const token of tokens) {
    await token.mint(lp.address, parseEther("100000000"));
    await token.approve(await liquidityRouter.getAddress(), MaxUint256);
    await token.connect(buyer).approve(await router.getAddress(), MaxUint256);
    await token.connect(other).approve(await router.getAddress(), MaxUint256);
  }
  await lower.mint(buyer.address, parseEther("1000000"));
  await upper.mint(buyer.address, parseEther("1000000"));
  for (const key of keys) {
    await manager.initialize(key, PRICE);
    await liquidityRouter["modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)"](
      key, [-60000, 60000, parseEther("10000000"), ZeroHash], "0x");
  }
  const buy = (amount = LOT, which = 0) => router.connect(buyer)
    .swap(keys[which], which === 0, amount, parseEther("1000000"), 0, MaxUint256);
  const sell = (amount: bigint, lotId = 1, which = 1) => router.connect(buyer)
    .swap(keys[which], which === 1, -amount, 1, lotId, MaxUint256);
  const wrapped = new Contract(managerAddress,
    ["error WrappedError(address target,bytes4 selector,bytes reason,bytes details)"], lp);
  async function hookRevert(call: Promise<unknown>, callback: "afterSwap" | "beforeInitialize",
    reason: string, values: unknown[] = []) {
    await expect(call).to.be.revertedWithCustomError(wrapped, "WrappedError").withArgs(
      mined.hook, hook.interface.getFunction(callback).selector, hook.interface.encodeErrorResult(reason, values),
      hashSignature("HookCallFailed()").slice(0, 10));
  }
  return { lp, buyer, other, manager, managerAddress, hook, router, cas, lower, upper, keys, sources, buy, sell, hookRevert, deployCore };
}

describe("CASInstallmentHook / Uniswap v4", function () {
  it("entrega 20.000 CAS, libera 10.000 no segundo exato e aplica o prazo entre as duas vendas entre pools", async function () {
    const { buyer, cas, buy, sell, hook, hookRevert } = await loadFixture(fixture);
    await buy();
    expect(await cas.balanceOf(buyer.address)).to.equal(LOT);
    let lot = await hook.lots(buyer.address, 1);
    expect(lot.nextAmount).to.equal(HALF);
    await time.setNextBlockTimestamp(lot.sellAfter - 1n);
    await hookRevert(sell(HALF), "afterSwap", "TooEarly", [lot.sellAfter]);
    await time.setNextBlockTimestamp(lot.sellAfter);
    await sell(HALF);
    const next = await hook.lots(buyer.address, 1);
    expect(next.sellAfter).to.equal(lot.sellAfter + BigInt(DAY));
    await hookRevert(sell(HALF, 1, 0), "afterSwap", "TooEarly", [next.sellAfter]);
    await time.setNextBlockTimestamp(next.sellAfter);
    await sell(HALF, 1, 0);
    expect(await cas.balanceOf(buyer.address)).to.equal(0n);
    expect(await hook.outstanding(buyer.address)).to.equal(0n);
    await hookRevert(sell(HALF), "afterSwap", "UnknownLot");
  });

  it("conta a segunda espera da venda tardia e rejeita parcelas parciais e o lote inteiro", async function () {
    const { buyer, buy, sell, hook, hookRevert } = await loadFixture(fixture);
    await buy();
    await time.increase(4 * DAY);
    await hookRevert(sell(HALF - 1n), "afterSwap", "WrongInstallment", [HALF]);
    await hookRevert(sell(LOT), "afterSwap", "WrongInstallment", [HALF]);
    await sell(HALF);
    const next = await hook.lots(buyer.address, 1);
    expect(next.sellAfter).to.equal(BigInt(await time.latest()) + BigInt(DAY));
    await hookRevert(sell(HALF), "afterSwap", "TooEarly", [next.sellAfter]);
  });

  it("mantém compras independentes nas duas ordens das moedas e credita o delta entregue no exact input", async function () {
    const { buyer, cas, buy, sell, hook, router, keys } = await loadFixture(fixture);
    await buy();
    const first = await hook.lots(buyer.address, 1);
    await time.increase(DAY / 2);
    await router.connect(buyer).swap(keys[1], false, -LOT, 1, 0, MaxUint256);
    const added = await cas.balanceOf(buyer.address) - LOT;
    const second = await hook.lots(buyer.address, 2);
    expect(second.nextAmount + second.lastAmount).to.equal(added);
    expect(second.sellAfter).to.be.greaterThan(first.sellAfter);
    await time.setNextBlockTimestamp(first.sellAfter);
    await sell(HALF);
    expect((await hook.lots(buyer.address, 2)).sellAfter).to.equal(second.sellAfter);
  });

  it("registra CAS recebido sem custódia, evita dupla contagem e separa os direitos entre carteiras", async function () {
    const { buyer, other, cas, buy, hook, router, keys, hookRevert } = await loadFixture(fixture);
    await buy();
    await expect(hook.connect(buyer).registerBalance(1)).to.be.revertedWithCustomError(hook, "UnregisteredBalance").withArgs(0);
    await cas.connect(buyer).transfer(other.address, LOT);
    expect(await hook.registrableBalance(buyer.address)).to.equal(0n);
    const sellOther = () => router.connect(other).swap(keys[1], true, -HALF, 1, 1, MaxUint256);
    await hookRevert(sellOther(), "afterSwap", "UnknownLot");
    await hook.connect(other).registerBalance(LOT);
    expect(await cas.balanceOf(other.address)).to.equal(LOT);
    const lot = await hook.lots(other.address, 1);
    await hookRevert(sellOther(), "afterSwap", "TooEarly", [lot.sellAfter]);
    await hook.connect(buyer).discardAllLots();
    expect(await hook.outstanding(buyer.address)).to.equal(0);
    await time.setNextBlockTimestamp(lot.sellAfter);
    await sellOther();
    expect(await cas.balanceOf(other.address)).to.equal(HALF);
  });

  it("arredonda a primeira parcela para cima e agenda uma única parcela para lotes unitários", async function () {
    const { buyer, cas, hook } = await loadFixture(fixture);
    await cas.mint(buyer.address, 6);
    await hook.connect(buyer).registerBalance(5);
    await hook.connect(buyer).registerBalance(1);
    const odd = await hook.lots(buyer.address, 1);
    const unit = await hook.lots(buyer.address, 2);
    expect([odd.nextAmount, odd.lastAmount, unit.nextAmount, unit.lastAmount]).to.deep.equal([3n, 2n, 1n, 0n]);
    await expect(hook.connect(buyer).registerBalance(0)).to.be.revertedWithCustomError(hook, "InvalidAmount");
  });

  it("protege a compra nova quando a carteira transferiu os CAS de um lote anterior", async function () {
    const { buyer, other, cas, buy, sell, hook, hookRevert } = await loadFixture(fixture);
    await buy();
    const first = await hook.lots(buyer.address, 1);
    await cas.connect(buyer).transfer(other.address, LOT);
    await time.setNextBlockTimestamp(first.sellAfter);
    await buy();
    await hookRevert(sell(HALF), "afterSwap", "LotsExceedBalance", [2n * LOT, LOT]);
    await hook.connect(buyer).discardAllLots();
    expect((await hook.lots(buyer.address, 1)).nextAmount).to.equal(0);
    await hookRevert(sell(HALF, 2), "afterSwap", "UnknownLot");
    await hook.connect(buyer).registerBalance(LOT);
    const fresh = await hook.lots(buyer.address, 3);
    await hookRevert(sell(HALF, 3), "afterSwap", "TooEarly", [fresh.sellAfter]);
    await time.setNextBlockTimestamp(fresh.sellAfter);
    await sell(HALF, 3);
  });

  it("reverte a contabilidade quando falha slippage, prazo ou pagamento", async function () {
    const { buyer, router, hook, cas, keys, buy } = await loadFixture(fixture);
    await expect(router.connect(buyer).swap(keys[0], true, LOT, 1, 0, MaxUint256))
      .to.be.revertedWithCustomError(router, "SlippageExceeded");
    await expect(router.connect(buyer).swap(keys[0], true, LOT, 100, 0, 1)).to.be.revertedWithCustomError(router, "Expired");
    expect(await hook.lastLotId(buyer.address)).to.equal(0);
    await buy();
    const lot = await hook.lots(buyer.address, 1);
    await cas.connect(buyer).approve(await router.getAddress(), 0);
    await time.setNextBlockTimestamp(lot.sellAfter);
    await expect(router.connect(buyer).swap(keys[1], true, -HALF, 1, 1, MaxUint256))
      .to.be.revertedWithCustomError(cas, "ERC20InsufficientAllowance");
    expect(await hook.outstanding(buyer.address)).to.equal(LOT);
    expect((await hook.lots(buyer.address, 1)).sellAfter).to.equal(lot.sellAfter);
  });

  it("vincula a carteira ao roteador e os callbacks ao PoolManager", async function () {
    const { buyer, router, hook, keys, sources, managerAddress, hookRevert, deployCore } = await loadFixture(fixture);
    const params = { zeroForOne: true, amountSpecified: -1000000n, sqrtPriceLimitX96: 4295128740n };
    await expect(hook.afterSwap(buyer.address, keys[0], params, 0, "0x"))
      .to.be.revertedWithCustomError(hook, "OnlyManager");
    await expect(router.unlockCallback("0x")).to.be.revertedWithCustomError(router, "OnlyManager");
    await expect(router.swap(sources[0], true, -1000, 1, 0, MaxUint256)).to.be.revertedWithCustomError(router, "UnsupportedPool");
    const alternate = await deployCore("PoolSwapTest", managerAddress);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [buyer.address, 0]);
    await hookRevert(alternate.swap(keys[0], params, [false, false], data), "afterSwap", "OnlyRouter");
  });

  it("restringe a inicialização ao responsável, aos pares previstos e ao preço atual da origem", async function () {
    const { manager, other, keys, hookRevert } = await loadFixture(fixture);
    await hookRevert((manager.connect(other) as Contract).initialize(keys[0], PRICE), "beforeInitialize", "OnlyInitializer");
    await hookRevert(manager.initialize({ ...keys[0], fee: 500 }, PRICE), "beforeInitialize", "UnsupportedPool");
    await hookRevert(manager.initialize(keys[0], PRICE + 1n), "beforeInitialize", "SourcePriceChanged");
  });
});
