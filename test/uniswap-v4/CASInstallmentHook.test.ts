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
// LOT representa 20.000 tokens e HALF representa a parcela de 10.000, ambos em unidades mínimas.
const LOT = parseEther("20000");
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
  it("entrega 20.000 CAS, libera 10.000 no segundo exato e aplica o prazo entre as duas vendas entre pools", async function () {
    const { buyer, cas, buy, sell, hook, hookRevert } = await loadFixture(fixture);
    await buy();
    // O saldo do ERC-20 prova a entrega. O lote é um registro separado que indica quanto vender
    // e a partir de quando. setNextBlockTimestamp escolhe o horário da próxima transação local.
    expect(await cas.balanceOf(buyer.address)).to.equal(LOT);
    let lot = await hook.lots(buyer.address, 1);
    expect(lot.nextAmount).to.equal(HALF);
    await time.setNextBlockTimestamp(lot.sellAfter - 1n);
    await hookRevert(sell(HALF), "afterSwap", "TooEarly", [lot.sellAfter]);
    // Um segundo antes falhou. No segundo exato passa, mesmo vendendo no outro par participante.
    await time.setNextBlockTimestamp(lot.sellAfter);
    await sell(HALF);
    const next = await hook.lots(buyer.address, 1);
    expect(next.sellAfter).to.equal(lot.sellAfter + BigInt(DAY));
    // Voltar ao primeiro pool consulta o mesmo lote. Após a segunda parcela, tanto o saldo
    // quanto o compromisso chegam a zero e não há uma terceira venda para o mesmo ID.
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
    // Mesmo esperando quatro dias, a primeira venda precisa consumir a parcela inteira.
    // Subtrair uma unidade mínima já deve falhar. Tentar consumir as duas de uma vez também.
    await hookRevert(sell(HALF - 1n), "afterSwap", "WrongInstallment", [HALF]);
    await hookRevert(sell(LOT), "afterSwap", "WrongInstallment", [HALF]);
    await sell(HALF);
    const next = await hook.lots(buyer.address, 1);
    // time.latest() é o timestamp do bloco da venda. É dele que se contam as 24 horas restantes.
    expect(next.sellAfter).to.equal(BigInt(await time.latest()) + BigInt(DAY));
    await hookRevert(sell(HALF), "afterSwap", "TooEarly", [next.sellAfter]);
  });

  it("mantém compras independentes nas duas ordens das moedas e credita o delta entregue no exact input", async function () {
    const { buyer, cas, buy, sell, hook, router, keys } = await loadFixture(fixture);
    await buy();
    const first = await hook.lots(buyer.address, 1);
    await time.increase(DAY / 2);
    // Desta vez fixamos a entrada da outra moeda. Preço e taxa determinam o CAS de saída.
    // A diferença no saldo da carteira deve coincidir exatamente com a soma das parcelas do lote 2.
    await router.connect(buyer).swap(keys[1], false, -LOT, 1, 0, MaxUint256);
    const added = await cas.balanceOf(buyer.address) - LOT;
    const second = await hook.lots(buyer.address, 2);
    expect(second.nextAmount + second.lastAmount).to.equal(added);
    expect(second.sellAfter).to.be.greaterThan(first.sellAfter);
    await time.setNextBlockTimestamp(first.sellAfter);
    await sell(HALF);
    // Consumir uma parcela do primeiro lote deixa a data da segunda compra independente.
    expect((await hook.lots(buyer.address, 2)).sellAfter).to.equal(second.sellAfter);
  });

  it("registra CAS recebido sem custódia, evita dupla contagem e separa os direitos entre carteiras", async function () {
    const { buyer, other, cas, buy, hook, router, keys, hookRevert } = await loadFixture(fixture);
    await buy();
    // A compra já comprometeu os 20.000 CAS no primeiro lote. Até tentar registrar uma unidade a mais
    // excede o saldo disponível para novos registros, embora os tokens continuem na carteira.
    await expect(hook.connect(buyer).registerBalance(1)).to.be.revertedWithCustomError(hook, "UnregisteredBalance").withArgs(0);
    await cas.connect(buyer).transfer(other.address, LOT);
    expect(await hook.registrableBalance(buyer.address)).to.equal(0n);
    const sellOther = () => router.connect(other).swap(keys[1], true, -HALF, 1, 1, MaxUint256);
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
    expect(await cas.balanceOf(other.address)).to.equal(HALF);
  });

  it("arredonda a primeira parcela para cima e agenda uma única parcela para lotes unitários", async function () {
    const { buyer, cas, hook } = await loadFixture(fixture);
    await cas.mint(buyer.address, 6);
    // Os literais aqui são unidades mínimas, sem parseEther. Cinco se divide em três mais duas,
    // uma unidade vira uma única parcela e zero não representa um lote válido.
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
    // Fixar uma saída de 20.000 CAS e autorizar um gasto máximo de uma unidade da outra moeda
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
    await expect(router.connect(buyer).swap(keys[1], true, -HALF, 1, 1, MaxUint256))
      .to.be.revertedWithCustomError(cas, "ERC20InsufficientAllowance");
    expect(await hook.outstanding(buyer.address)).to.equal(LOT);
    expect((await hook.lots(buyer.address, 1)).sellAfter).to.equal(lot.sellAfter);
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
