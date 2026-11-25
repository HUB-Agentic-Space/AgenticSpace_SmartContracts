import {
  AbiCoder, concat, Contract, dataSlice, getAddress, getCreate2Address,
  keccak256, Provider, toBeHex, ZeroAddress,
} from "ethers";

// Na Polygon PoS, o PoolManager mantém o estado de vários pools em um único contrato.
// O PositionManager permite recuperar a chave usada nas posições de liquidez. O StateView
// expõe leituras do preço e da liquidez. getAddress normaliza a escrita dos endereços.
export const CAS = "0x5151A34EaC7bA08cd6B540b32cD30316218A2287";
export const MANAGER = getAddress("0x67366782805870060151383f4bbff9dab53e5cd6");
export const POSITIONS = getAddress("0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9");
export const STATE_VIEW = getAddress("0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a");
// Esta factory executa CREATE2. O script de implantação compara o hash do código que
// existe nesse endereço com o valor abaixo antes de confiar a ele a criação do hook.
export const FACTORY = getAddress("0x4e59b44847b379578588920ca78fbf26c0b4956c");
export const FACTORY_CODE_HASH = "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989";

// Cada linha identifica um pool de origem por símbolo, endereço do outro ERC-20 e ID de 32 bytes.
// O símbolo facilita a leitura humana. Para reconhecer o pool, conferimos a chave completa na rede.
const SOURCES = [
  ["USDC", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "0x184f2790d70b20af6130f87e22ef832693ff589148310b5482a0e749b9c3a76f"],
  ["USDT", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "0xe92c05c0729dc356b7dd4e2114ace9ff39ed3cb73b150c32a705ce5c8a63ef1f"],
  ["WPOL", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "0xe734da5beaea37909294fc34be04f7a677265ec9795ee8a399ae9bdff3aa637d"],
  ["WETH", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "0xf7b92470206a71c0fc1086e5d2776724cbaa5e283dc99c1a2312dc44d9e755d3"],
  ["BRLA", "0xE6A537a407488807F0bbeb0038B79004f19DDDFb", "0x448c14123033f44cbb363d0a812b985b2c2b297648dbaba3d1df7434a14e04cb"],
] as const;

// PoolKey é a identidade do pool. A ordem e os tipos abaixo reproduzem os campos do Solidity.
// As moedas ficam em ordem numérica de endereço. Trocar o endereço do hook também muda o ID.
export const KEY_TYPE = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
export interface Key {
  currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string;
}
export function poolId(key: Key): string {
  // abi.encode transforma os cinco campos em bytes segundo a ABI da Ethereum. keccak256 calcula
  // o mesmo identificador que key.toId() calcula no contrato. Um PoolId não é um endereço ERC-20.
  return keccak256(AbiCoder.defaultAbiCoder().encode([KEY_TYPE], [key]));
}

// Um Provider consulta o nó por RPC. Chamamos apenas funções de leitura para obter o inventário.
export async function inventory(provider: Provider) {
  // Estes endereços e IDs pertencem à chain 137. O sufixo n indica um bigint do TypeScript.
  if ((await provider.getNetwork()).chainId !== 137n) throw new Error("Use Polygon PoS (137) ou um fork com chain ID 137.");
  const block = await provider.getBlock("latest");
  if (!block?.hash) throw new Error("Bloco Polygon indisponível.");
  // Todas as leituras usam a mesma altura. Sem blockTag, dois pares poderiam ser lidos em blocos
  // diferentes. O hash devolvido ao final identifica qual bloco serviu de referência no plano.
  const at = { blockTag: block.number };
  // Estas ABIs mínimas descrevem para o ethers como codificar cada consulta e decodificar a resposta.
  const state = new Contract(STATE_VIEW, [
    "function poolManager() view returns (address)",
    "function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)",
    "function getLiquidity(bytes32) view returns (uint128)",
  ], provider);
  const positions = new Contract(POSITIONS, [
    "function poolManager() view returns (address)",
    "function poolKeys(bytes25) view returns (address,address,uint24,int24,address)",
  ], provider);
  // Os dois auxiliares precisam apontar para o mesmo PoolManager usado no deploy.
  const [stateManager, positionManager] = await Promise.all([state.poolManager(at), positions.poolManager(at)]);
  if (stateManager !== MANAGER || positionManager !== MANAGER) throw new Error("Referência de PoolManager divergente.");
  const pools = await Promise.all(SOURCES.map(async ([symbol, token, id]) => {
    // O índice do PositionManager usa os primeiros 25 bytes do ID. Preço e liquidez usam os 32.
    // As três consultas são independentes e podem ser feitas em paralelo no bloco escolhido.
    const [values, slot, liquidity] = await Promise.all([
      positions.poolKeys(dataSlice(id, 0, 25), at), state.getSlot0(id, at), state.getLiquidity(id, at),
    ]);
    const key: Key = { currency0: values[0], currency1: values[1], fee: Number(values[2]),
      tickSpacing: Number(values[3]), hooks: values[4] };
    const currencies = [key.currency0, key.currency1];
    // Recalcular o ID inteiro confirma a chave encontrada pelo índice abreviado. Os campos esperados
    // são CAS e o token do par, hook zero, taxa de 3.000 milionésimos (0,30%) e ticks espaçados de 60.
    // slot[0] guarda sqrtPriceX96. Zero indica que o pool ainda não recebeu um preço inicial.
    if (poolId(key) !== id || !currencies.includes(CAS) || !currencies.includes(getAddress(token)) ||
        key.hooks !== ZeroAddress || key.fee !== 3000 || key.tickSpacing !== 60 || slot[0] === 0n) {
      throw new Error("Pool de origem divergente ou sem inicialização: CAS/" + symbol);
    }
    // getLiquidity mede a liquidez ativa no tick atual. Para obter saldos de tokens seriam
    // necessários outros cálculos. Usamos strings decimais para preservar inteiros grandes no JSON.
    return { symbol, id, key, sqrtPriceX96: slot[0].toString(), activeLiquidity: liquidity.toString() };
  }));
  return { block: block.number, blockHash: block.hash, pools };
}

export function mineHook(initCode: string) {
  // initCode reúne o código de criação e os argumentos do construtor. CREATE2 combina o byte 0xff,
  // o endereço da factory, um salt de 32 bytes e o hash do initCode. Os últimos 20 bytes do hash
  // dessa combinação dão o endereço futuro. Podemos testar todos esses valores fora da blockchain.
  const hash = keccak256(initCode);
  // O v4 interpreta os 14 bits inferiores do endereço como permissões. A máscara 0x3fff seleciona
  // esses bits. Exigir 0x2040 ativa apenas beforeInitialize (bit 13) e afterSwap (bit 6).
  for (let i = 0; i < 1_000_000; i++) {
    const salt = toBeHex(i, 32);
    const hook = getCreate2Address(FACTORY, salt, hash);
    // O primeiro endereço compatível encerra a busca. A factory espera receber o salt seguido pelo
    // initCode em uma futura transação. Até este return o script fez apenas cálculos locais.
    if ((BigInt(hook) & 0x3fffn) === 0x2040n) return { hook, data: concat([salt, initCode]) };
  }
  throw new Error("Salt CREATE2 não encontrado.");
}
