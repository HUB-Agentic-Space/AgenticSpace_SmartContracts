import {
  AbiCoder, concat, Contract, dataSlice, getAddress, getCreate2Address,
  keccak256, Provider, toBeHex, ZeroAddress,
} from "ethers";

export const CAS = "0x5151A34EaC7bA08cd6B540b32cD30316218A2287";
export const MANAGER = getAddress("0x67366782805870060151383f4bbff9dab53e5cd6");
export const POSITIONS = getAddress("0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9");
export const STATE_VIEW = getAddress("0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a");
export const FACTORY = getAddress("0x4e59b44847b379578588920ca78fbf26c0b4956c");
export const FACTORY_CODE_HASH = "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989";

// IDs of the existing Polygon PoS pools. Reconstruct and verify each key on chain before use.
const SOURCES = [
  ["USDC", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "0x184f2790d70b20af6130f87e22ef832693ff589148310b5482a0e749b9c3a76f"],
  ["USDT", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "0xe92c05c0729dc356b7dd4e2114ace9ff39ed3cb73b150c32a705ce5c8a63ef1f"],
  ["WPOL", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "0xe734da5beaea37909294fc34be04f7a677265ec9795ee8a399ae9bdff3aa637d"],
  ["WETH", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "0xf7b92470206a71c0fc1086e5d2776724cbaa5e283dc99c1a2312dc44d9e755d3"],
  ["BRLA", "0xE6A537a407488807F0bbeb0038B79004f19DDDFb", "0x448c14123033f44cbb363d0a812b985b2c2b297648dbaba3d1df7434a14e04cb"],
] as const;

export const KEY_TYPE = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
export interface Key {
  currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string;
}
export function poolId(key: Key): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode([KEY_TYPE], [key]));
}

export async function inventory(provider: Provider) {
  if ((await provider.getNetwork()).chainId !== 137n) throw new Error("Use Polygon PoS (137) ou um fork com chain ID 137.");
  const block = await provider.getBlock("latest");
  if (!block?.hash) throw new Error("Bloco Polygon indisponível.");
  const at = { blockTag: block.number };
  const state = new Contract(STATE_VIEW, [
    "function poolManager() view returns (address)",
    "function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)",
    "function getLiquidity(bytes32) view returns (uint128)",
  ], provider);
  const positions = new Contract(POSITIONS, [
    "function poolManager() view returns (address)",
    "function poolKeys(bytes25) view returns (address,address,uint24,int24,address)",
  ], provider);
  const [stateManager, positionManager] = await Promise.all([state.poolManager(at), positions.poolManager(at)]);
  if (stateManager !== MANAGER || positionManager !== MANAGER) throw new Error("Referência de PoolManager divergente.");
  const pools = await Promise.all(SOURCES.map(async ([symbol, token, id]) => {
    const [values, slot, liquidity] = await Promise.all([
      positions.poolKeys(dataSlice(id, 0, 25), at), state.getSlot0(id, at), state.getLiquidity(id, at),
    ]);
    const key: Key = { currency0: values[0], currency1: values[1], fee: Number(values[2]),
      tickSpacing: Number(values[3]), hooks: values[4] };
    const currencies = [key.currency0, key.currency1];
    if (poolId(key) !== id || !currencies.includes(CAS) || !currencies.includes(getAddress(token)) ||
        key.hooks !== ZeroAddress || key.fee !== 3000 || key.tickSpacing !== 60 || slot[0] === 0n) {
      throw new Error("Pool de origem divergente ou sem inicialização: CAS/" + symbol);
    }
    return { symbol, id, key, sqrtPriceX96: slot[0].toString(), activeLiquidity: liquidity.toString() };
  }));
  return { block: block.number, blockHash: block.hash, pools };
}

export function mineHook(initCode: string) {
  const hash = keccak256(initCode);
  // beforeInitialize (bit 13) + afterSwap (bit 6), all other flags clear.
  for (let i = 0; i < 1_000_000; i++) {
    const salt = toBeHex(i, 32);
    const hook = getCreate2Address(FACTORY, salt, hash);
    if ((BigInt(hook) & 0x3fffn) === 0x2040n) return { hook, data: concat([salt, initCode]) };
  }
  throw new Error("Salt CREATE2 não encontrado.");
}
