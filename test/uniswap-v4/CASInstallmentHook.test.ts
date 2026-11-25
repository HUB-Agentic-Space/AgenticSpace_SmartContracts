import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { Contract, ContractFactory, id as hashSignature, MaxUint256, parseEther, ZeroAddress, ZeroHash } from "ethers";
import { FACTORY, FACTORY_CODE_HASH, Key, mineHook, poolId } from "../../scripts/uniswap-v4/pools";

// O relógio da EVM conta segundos. Em Q64.96, deslocar 1 por 96 bits representa a raiz
// quadrada de 1. Com as duas moedas de teste de 18 casas, isso inicia o pool no preço 1 por 1.
const DAY = 86_400;
const PRICE = 1n << 96n;
// parseEther multiplica por 10^18. Usamos a função pelas 18 casas do CAS simulado.
// LOT representa 21.000 tokens e HALF é o teto inicial de 10.500, ambos em unidades mínimas.
const LOT = parseEther("21000");
const HALF = LOT / 2n;
const FACTORY_CODE = "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

async function fixture() {
  // A fixture monta o cenário uma vez. loadFixture restaura o mesmo estado inicial entre os testes.
  // lp fornece liquidez, buyer negocia e other representa uma segunda carteira com lotes próprios.
  const [lp, buyer, other] = await ethers.getSigners();
  async function deployCore(name: string, arg: string) {
    // O pacote do Uniswap fornece a ABI e o bytecode compilado do núcleo. Executar seu PoolManager
    // exercita o cálculo de um swap e os callbacks que realmente chegariam aos nossos contratos.
    const artifact = require("@uniswap/v4-core/out/" + name + ".sol/" + name + ".json");
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode.object, lp).deploy(arg);
    await contract.waitForDeployment();
    return new Contract(await contract.getAddress(), artifact.abi, lp);
  }
  const manager = await deployCore("PoolManager", lp.address);
  const managerAddress = await manager.getAddress();
  // Este auxiliar do Uniswap deposita liquidez. Mais adiante, as carteiras usarão um roteador
  // diferente para fazer swaps. Cada contrato precisa de sua própria aprovação para gastar tokens.
  const liquidityRouter = await deployCore("PoolModifyLiquidityTest", managerAddress);
  const tokenFactory = await ethers.getContractFactory("MockERC20");
  const tokens = [];
  for (const symbol of ["A", "B", "C"]) {
    const token = await tokenFactory.deploy(symbol, symbol, 18);
    await token.waitForDeployment();
    tokens.push(token);
  }
  tokens.sort((a, b) => String(a.target).toLowerCase().localeCompare(String(b.target).toLowerCase()));
  // Escolher o endereço intermediário como CAS cria dois cenários naturais de ordenação.
  // No primeiro par CAS é currency1 e no segundo é currency0. O mesmo hook precisa atender ambos.
  const [lower, cas, upper] = tokens;
  const casAddress = await cas.getAddress();
  const sources: Key[] = [
    { currency0: await lower.getAddress(), currency1: casAddress, fee: 3000, tickSpacing: 60, hooks: ZeroAddress },
    { currency0: casAddress, currency1: await upper.getAddress(), fee: 3000, tickSpacing: 60, hooks: ZeroAddress },
  ];
  for (const source of sources) await manager.initialize(source, PRICE);
  // hardhat_setCode instala a factory na rede de teste local. Conferimos o hash antes de usá-la.
  // O restante da implantação percorre o mesmo CREATE2 e a mesma busca dos bits usados no script.
  expect(ethers.keccak256(FACTORY_CODE)).to.equal(FACTORY_CODE_HASH);
  await network.provider.send("hardhat_setCode", [FACTORY, FACTORY_CODE]);
  const hookFactory = await ethers.getContractFactory("CASInstallmentHook");
  const creation = await hookFactory.getDeployTransaction(managerAddress, casAddress, lp.address, sources.map(poolId));
  const mined = mineHook(creation.data);
  await (await lp.sendTransaction({ to: FACTORY, data: mined.data })).wait();
  const hook = await ethers.getContractAt("CASInstallmentHook", mined.hook);
  const router = await ethers.getContractAt("CASInstallmentRouter", await hook.router());
  // Substituir hooks cria duas chaves sucessoras. As origens, já inicializadas, fornecem o preço
  // que beforeInitialize vai conferir quando os novos pools forem abertos.
  const keys = sources.map(source => ({ ...source, hooks: mined.hook }));
  for (const token of tokens) {
    // mint financia o provedor. approve dá permissão de débito ao roteador correspondente,
    // sem transferir saldo. MaxUint256 evita renovar a aprovação a cada operação destes testes.
    await token.mint(lp.address, parseEther("100000000"));
    await token.approve(await liquidityRouter.getAddress(), MaxUint256);
    await token.connect(buyer).approve(await router.getAddress(), MaxUint256);
    await token.connect(other).approve(await router.getAddress(), MaxUint256);
  }
  await lower.mint(buyer.address, parseEther("1000000"));
  await upper.mint(buyer.address, parseEther("1000000"));
  for (const key of keys) {
    await manager.initialize(key, PRICE);
    // O preço inicial corresponde ao tick zero. Os limites -60000 e 60000 são múltiplos de 60
    // e abrangem o preço. A posição fornece liquidez para executar as compras e vendas do teste.
    await liquidityRouter["modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)"](
      key, [-60000, 60000, parseEther("10000000"), ZeroHash], "0x");
  }
  // Para comprar pedimos saída exata de CAS (valor positivo) e lote zero. Para vender fixamos
  // a entrada de CAS (valor negativo) e informamos o lote. which seleciona o pool e a direção.
  // O último argumento deixa a ordem sem vencimento prático no teste. sellAfter continua valendo.
  const buy = (amount = LOT, which = 0) => router.connect(buyer)
    .swap(keys[which], which === 0, amount, parseEther("1000000"), 0, MaxUint256);
  const sell = (amount: bigint, lotId = 1, which = 1) => router.connect(buyer)
    .swap(keys[which], which === 1, -amount, 1, lotId, MaxUint256);
  // O PoolManager encapsula a falha do hook em WrappedError. Verificamos o endereço, o seletor
  // do callback (quatro bytes) e o erro interno com seus argumentos. Assim sabemos qual regra reverteu.
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
  it("permite vender o máximo de um lote de 21.000 CAS em 13 datas, entre pools, até zerar", async function () {
    const { buyer, cas, buy, sell, hook, keys, hookRevert } = await loadFixture(fixture);
    await buy();
    const boughtAt = BigInt(await time.latest());
    expect(await cas.balanceOf(buyer.address)).to.equal(LOT);
    // Os valores esperados são independentes do cálculo do contrato. As duas últimas vendas são
    // iguais porque dividir novamente 5,126953125 deixaria apenas 2,5634765625 CAS.
    const sales = [
      "10500", "5250", "2625", "1312.5", "656.25", "328.125", "164.0625",
      "82.03125", "41.015625", "20.5078125", "10.25390625", "5.126953125", "5.126953125",
    ];
    let remaining = LOT;
    for (const [i, value] of sales.entries()) {
      const amount = parseEther(value);
      const due = boughtAt + BigInt((i + 1) * DAY);
      const lot = await hook.lots(buyer.address, 1);
      expect(lot.nextAmount).to.equal(amount);
      expect(lot.lastAmount).to.equal(remaining - amount);
      expect(lot.sellAfter).to.equal(due);

      // Alternar o par confirma que o prazo pertence ao lote. Um segundo antes a venda reverte.
      // No primeiro segundo permitido, o evento deve informar o novo prazo ou zero no encerramento.
      const which = i % 2;
      await time.setNextBlockTimestamp(due - 1n);
      await hookRevert(sell(amount, 1, which), "afterSwap", "TooEarly", [due]);
      await time.setNextBlockTimestamp(due);
      remaining -= amount;
      await expect(sell(amount, 1, which)).to.emit(hook, "InstallmentSold")
        .withArgs(buyer.address, 1, poolId(keys[which]), amount, remaining === 0n ? 0n : due + BigInt(DAY));
      expect(await cas.balanceOf(buyer.address)).to.equal(remaining);
      expect(await hook.outstanding(buyer.address)).to.equal(remaining);
    }
    expect(remaining).to.equal(0n);
    expect(Array.from(await hook.lots(buyer.address, 1))).to.deep.equal([0n, 0n, 0n]);
    await hookRevert(sell(HALF), "afterSwap", "UnknownLot");
  });

  it("aceita vendas parciais e recalcula o teto e as 24 horas pelo valor efetivamente vendido", async function () {
    const { buyer, cas, buy, sell, hook, router, keys, hookRevert } = await loadFixture(fixture);
    await buy();
    await time.increase(4 * DAY);
    // Quatro dias de espera não acumulam limites. Até uma unidade mínima acima de 10.500 é recusada.
    await expect(sell(0n)).to.be.revertedWithCustomError(router, "InvalidAmount");
    await hookRevert(sell(HALF + 1n), "afterSwap", "WrongInstallment", [HALF]);
    await hookRevert(sell(LOT), "afterSwap", "WrongInstallment", [HALF]);
    // A carteira escolhe 3.000. O lote e o ERC-20 ficam com 18.000, e a próxima venda pode ir até 9.000.
    const chosen = parseEther("3000");
    const firstSale = await sell(chosen);
    const next = await hook.lots(buyer.address, 1);
    expect([next.nextAmount, next.lastAmount]).to.deep.equal([parseEther("9000"), parseEther("9000")]);
    expect(await hook.outstanding(buyer.address)).to.equal(parseEther("18000"));
    expect(await cas.balanceOf(buyer.address)).to.equal(parseEther("18000"));
    expect(await hook.registrableBalance(buyer.address)).to.equal(0n);
    expect(next.sellAfter).to.equal(BigInt(await time.latest()) + BigInt(DAY));
    await expect(firstSale).to.emit(hook, "InstallmentSold")
      .withArgs(buyer.address, 1, poolId(keys[1]), chosen, next.sellAfter);
    // Nem o limite que sobrou da primeira rodada nem a troca de pool dispensam a próxima espera.
    await time.setNextBlockTimestamp(next.sellAfter - 1n);
    await hookRevert(sell(parseEther("1"), 1, 0), "afterSwap", "TooEarly", [next.sellAfter]);
    await time.increase(3 * DAY);
    await hookRevert(sell(parseEther("9000") + 1n), "afterSwap", "WrongInstallment", [parseEther("9000")]);
    await sell(parseEther("8000"), 1, 0);
    const third = await hook.lots(buyer.address, 1);
    expect(third.nextAmount).to.equal(parseEther("5000"));
    expect(third.sellAfter).to.equal(BigInt(await time.latest()) + BigInt(DAY));
    expect(await hook.outstanding(buyer.address)).to.equal(parseEther("10000"));
    expect(await cas.balanceOf(buyer.address)).to.equal(parseEther("10000"));
  });

  it("confere em uma venda de saída fixa o CAS debitado, inclusive a taxa do swap", async function () {
    const { buyer, cas, buy, hook, router, keys, hookRevert } = await loadFixture(fixture);
    await buy();
    await time.increaseTo((await hook.lots(buyer.address, 1)).sellAfter);
    const trader = router.connect(buyer);
    // Neste pool de teste, comprar 10.500 da outra moeda exigiria mais de 10.500 CAS de entrada.
    await hookRevert(trader.swap(keys[1], true, HALF, LOT, 1, MaxUint256), "afterSwap", "WrongInstallment", [HALF]);
    const output = parseEther("1000");
    const [spent] = await trader.swap.staticCall(keys[1], true, output, HALF, 1, MaxUint256);
    expect(spent).to.be.greaterThan(output);
    await trader.swap(keys[1], true, output, HALF, 1, MaxUint256);
    const remaining = LOT - spent;
    expect(await cas.balanceOf(buyer.address)).to.equal(remaining);
    expect(await hook.outstanding(buyer.address)).to.equal(remaining);
    expect((await hook.lots(buyer.address, 1)).nextAmount).to.equal(remaining / 2n);
  });

  it("mantém compras independentes nas duas ordens das moedas e credita o delta entregue no exact input", async function () {
    const { buyer, cas, buy, sell, hook, router, keys } = await loadFixture(fixture);
    await buy();
    const first = await hook.lots(buyer.address, 1);
    await time.increase(DAY / 2);
    // Desta vez fixamos a entrada da outra moeda. Preço e taxa determinam o CAS de saída.
    // A diferença no saldo da carteira deve coincidir com a parcela liberável mais o saldo posterior do lote 2.
    await router.connect(buyer).swap(keys[1], false, -LOT, 1, 0, MaxUint256);
    const added = await cas.balanceOf(buyer.address) - LOT;
    const second = await hook.lots(buyer.address, 2);
    expect(second.nextAmount + second.lastAmount).to.equal(added);
    expect(second.sellAfter).to.be.greaterThan(first.sellAfter);
    await time.setNextBlockTimestamp(first.sellAfter);
    await sell(parseEther("500"));
    // A venda parcial abate somente o primeiro lote. O compromisso total ainda inclui o segundo.
    expect((await hook.lots(buyer.address, 2)).sellAfter).to.equal(second.sellAfter);
    expect(await hook.outstanding(buyer.address)).to.equal(LOT - parseEther("500") + added);
  });

  it("registra CAS recebido sem custódia, evita dupla contagem e separa os direitos entre carteiras", async function () {
    const { buyer, other, cas, buy, hook, router, keys, hookRevert } = await loadFixture(fixture);
    await buy();
    // A compra já comprometeu os 21.000 CAS no primeiro lote. Até tentar registrar uma unidade a mais
    // excede o saldo disponível para novos registros, embora os tokens continuem na carteira.
    await expect(hook.connect(buyer).registerBalance(1)).to.be.revertedWithCustomError(hook, "UnregisteredBalance").withArgs(0);
    await cas.connect(buyer).transfer(other.address, LOT);
    expect(await hook.registrableBalance(buyer.address)).to.equal(0n);
    const chosen = parseEther("1000");
    const sellOther = () => router.connect(other).swap(keys[1], true, -chosen, 1, 1, MaxUint256);
    // A transferência moveu os tokens. O destinatário tem sua própria numeração de lotes e deve
    // registrar o que recebeu. O saldo ERC-20 fica com ele durante toda a espera.
    await hookRevert(sellOther(), "afterSwap", "UnknownLot");
    await hook.connect(other).registerBalance(LOT);
    expect(await cas.balanceOf(other.address)).to.equal(LOT);
    const lot = await hook.lots(other.address, 1);
    await hookRevert(sellOther(), "afterSwap", "TooEarly", [lot.sellAfter]);
    await hook.connect(buyer).discardAllLots();
    // O remetente descarta seus próprios direitos. Isso não altera o prazo iniciado pelo destinatário.
    expect(await hook.outstanding(buyer.address)).to.equal(0);
    await time.setNextBlockTimestamp(lot.sellAfter);
    await sellOther();
    expect(await cas.balanceOf(other.address)).to.equal(LOT - chosen);
    expect((await hook.lots(other.address, 1)).nextAmount).to.equal((LOT - chosen) / 2n);
  });

  it("permite a quitação após 24 h e rejeita vendas que deixariam um resíduo positivo inferior a 5 CAS", async function () {
    const { buyer, cas, hook, buy, sell, hookRevert } = await loadFixture(fixture);
    // Com 10 CAS menos duas unidades mínimas, vender exatamente a metade deixaria 5 CAS menos uma unidade.
    const sizes = [parseEther("4.5"), parseEther("5"), parseEther("10") - 2n];
    for (const [i, amount] of sizes.entries()) {
      await buy(amount);
      const id = i + 1;
      const lot = await hook.lots(buyer.address, id);
      expect([lot.nextAmount, lot.lastAmount]).to.deep.equal([amount, 0n]);
      await time.setNextBlockTimestamp(lot.sellAfter - 1n);
      await hookRevert(sell(amount, id), "afterSwap", "TooEarly", [lot.sellAfter]);
      await time.setNextBlockTimestamp(lot.sellAfter);
      await hookRevert(sell(amount / 2n, id), "afterSwap", "RemainderTooSmall", [amount - amount / 2n]);
      await sell(amount, id);
      expect(await cas.balanceOf(buyer.address)).to.equal(0n);
      expect(await hook.outstanding(buyer.address)).to.equal(0n);
    }
  });

  it("deixa o titular de 9 CAS escolher uma venda menor que preserve 5 CAS ou o encerramento integral", async function () {
    const { buyer, cas, buy, sell, hook, hookRevert } = await loadFixture(fixture);
    const nine = parseEther("9");
    const four = parseEther("4");
    const five = parseEther("5");
    // Abrimos dois lotes iguais para exercitar as duas escolhas disponíveis no mesmo estado inicial.
    await buy(nine);
    await buy(nine);
    await time.increaseTo((await hook.lots(buyer.address, 2)).sellAfter);
    await hookRevert(sell(four + 1n), "afterSwap", "RemainderTooSmall", [five - 1n]);
    await hookRevert(sell(parseEther("8")), "afterSwap", "RemainderTooSmall", [parseEther("1")]);
    await hookRevert(sell(nine + 1n), "afterSwap", "WrongInstallment", [nine]);
    await sell(four);
    const last = await hook.lots(buyer.address, 1);
    expect([last.nextAmount, last.lastAmount]).to.deep.equal([five, 0n]);
    await sell(nine, 2);
    expect(await hook.outstanding(buyer.address)).to.equal(five);
    await hookRevert(sell(five), "afterSwap", "TooEarly", [last.sellAfter]);
    await time.setNextBlockTimestamp(last.sellAfter);
    await sell(five);
    expect(await cas.balanceOf(buyer.address)).to.equal(0n);
  });

  it("mantém os 5 CAS exatos e arredonda o teto para baixo mesmo quando falta uma unidade para 10 CAS", async function () {
    const { buyer, cas, hook, sell, hookRevert } = await loadFixture(fixture);
    const five = parseEther("5");
    const ten = parseEther("10");
    // Com 10 CAS menos uma unidade, o teto é 5 CAS menos uma unidade. Ainda ficam exatamente 5 CAS,
    // portanto o lote não pode ser fechado antecipadamente. Uma unidade ímpar fica sempre no saldo.
    const cases = [
      { balance: ten, sales: [five, five] },
      { balance: ten - 1n, sales: [five - 1n, five] },
      { balance: 2n * ten + 2n, sales: [ten + 1n, five, five + 1n] },
    ];
    for (const [i, { balance, sales }] of cases.entries()) {
      await cas.mint(buyer.address, balance);
      await hook.connect(buyer).registerBalance(balance);
      let remaining = balance;
      for (const amount of sales) {
        const lot = await hook.lots(buyer.address, i + 1);
        remaining -= amount;
        expect([lot.nextAmount, lot.lastAmount]).to.deep.equal([amount, remaining]);
        await time.increaseTo(lot.sellAfter);
        if (remaining > 0n) {
          await hookRevert(sell(amount + 1n, i + 1), "afterSwap", "WrongInstallment", [amount]);
          await hookRevert(sell(amount + remaining, i + 1), "afterSwap", "WrongInstallment", [amount]);
        }
        await sell(amount, i + 1);
        expect(await hook.outstanding(buyer.address)).to.equal(remaining);
      }
      expect(await cas.balanceOf(buyer.address)).to.equal(0n);
    }
  });

  it("aceita um lote de uma unidade mínima e rejeita um lote vazio", async function () {
    const { buyer, cas, hook } = await loadFixture(fixture);
    // O literal 1 representa 10^-18 CAS. O hook permite registrar essa unidade como parcela final.
    await cas.mint(buyer.address, 1);
    await hook.connect(buyer).registerBalance(1);
    const unit = await hook.lots(buyer.address, 1);
    expect([unit.nextAmount, unit.lastAmount]).to.deep.equal([1n, 0n]);
    await expect(hook.connect(buyer).registerBalance(0)).to.be.revertedWithCustomError(hook, "InvalidAmount");
  });

  it("protege a compra nova quando a carteira transferiu os CAS de um lote anterior", async function () {
    const { buyer, other, cas, buy, sell, hook, hookRevert } = await loadFixture(fixture);
    await buy();
    const first = await hook.lots(buyer.address, 1);
    await cas.connect(buyer).transfer(other.address, LOT);
    await time.setNextBlockTimestamp(first.sellAfter);
    await buy();
    // O livro agora registra dois lotes, mas o ERC-20 só mostra saldo para um. A venda do lote
    // vencido depende de a carteira ter cobertura para todos os compromissos pendentes.
    await hookRevert(sell(HALF), "afterSwap", "LotsExceedBalance", [2n * LOT, LOT]);
    // O descarte invalida os dois IDs de uma vez. O saldo efetivo pode ser registrado com ID 3
    // e prazo novo. Tentamos a venda antes e depois do vencimento para conferir o resultado.
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
    // Fixar uma saída de 21.000 CAS e autorizar um gasto máximo de uma unidade da outra moeda
    // ultrapassa a tolerância de preço. Uma ordem com deadline 1 já expirou no relógio do teste.
    await expect(router.connect(buyer).swap(keys[0], true, LOT, 1, 0, MaxUint256))
      .to.be.revertedWithCustomError(router, "SlippageExceeded");
    await expect(router.connect(buyer).swap(keys[0], true, LOT, 100, 0, 1)).to.be.revertedWithCustomError(router, "Expired");
    expect(await hook.lastLotId(buyer.address)).to.equal(0);
    await buy();
    const lot = await hook.lots(buyer.address, 1);
    // Revogar a aprovação faz o pagamento falhar depois de afterSwap. A reversão é atômica.
    // Conferimos no estado persistido que o saldo comprometido e a data do lote voltaram ao valor inicial.
    await cas.connect(buyer).approve(await router.getAddress(), 0);
    await time.setNextBlockTimestamp(lot.sellAfter);
    await expect(router.connect(buyer).swap(keys[1], true, -parseEther("1000"), 1, 1, MaxUint256))
      .to.be.revertedWithCustomError(cas, "ERC20InsufficientAllowance");
    expect(await hook.outstanding(buyer.address)).to.equal(LOT);
    expect(Array.from(await hook.lots(buyer.address, 1))).to.deep.equal(Array.from(lot));
  });

  it("vincula a carteira ao roteador e os callbacks ao PoolManager", async function () {
    const { buyer, router, hook, keys, sources, managerAddress, hookRevert, deployCore } = await loadFixture(fixture);
    const params = { zeroForOne: true, amountSpecified: -1000000n, sqrtPriceLimitX96: 4295128740n };
    // Chamadas diretas não vêm do PoolManager. Também verificamos que este roteador reconhece
    // a chave pelo hook, impedindo usar a chave de um pool de origem com hooks igual a zero.
    await expect(hook.afterSwap(buyer.address, keys[0], params, 0, "0x"))
      .to.be.revertedWithCustomError(hook, "OnlyManager");
    await expect(router.unlockCallback("0x")).to.be.revertedWithCustomError(router, "OnlyManager");
    await expect(router.swap(sources[0], true, -1000, 1, 0, MaxUint256)).to.be.revertedWithCustomError(router, "UnsupportedPool");
    const alternate = await deployCore("PoolSwapTest", managerAddress);
    // Aqui o manager é legítimo, mas o roteador que iniciou o swap é outro. Colocar o endereço
    // de buyer em hookData não muda o sender que o próprio manager entrega ao callback.
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [buyer.address, 0]);
    await hookRevert(alternate.swap(keys[0], params, [false, false], data), "afterSwap", "OnlyRouter");
  });

  it("restringe a inicialização ao responsável, aos pares previstos e ao preço atual da origem", async function () {
    const { manager, other, keys, hookRevert } = await loadFixture(fixture);
    // Mudamos um parâmetro por vez. Outra carteira falha na autorização, outra taxa produz
    // uma chave de origem diferente e uma única unidade de sqrtPriceX96 já diverge do preço.
    await hookRevert((manager.connect(other) as Contract).initialize(keys[0], PRICE), "beforeInitialize", "OnlyInitializer");
    await hookRevert(manager.initialize({ ...keys[0], fee: 500 }, PRICE), "beforeInitialize", "UnsupportedPool");
    await hookRevert(manager.initialize(keys[0], PRICE + 1n), "beforeInitialize", "SourcePriceChanged");
  });
});
