---
tags:
  - scan
  - dex
  - liquidity
  - polygon
---

# Scan de DEXs na Polygon — CAS remanescente

> Varredura em busca de liquidez/pares que ainda contenham tokens CAS.

## Metadata

| Campo | Valor |
|---|---|
| Rede | Polygon PoS Mainnet |
| Chain ID | 137 |
| Bloco | 90943781 |
| Timestamp | 2026-07-27T02:50:59.047Z |
| CAS Token | 0x5151A34EaC7bA08cd6B540b32cD30316218A2287 |
| DEXs escaneados | QuickSwap, SushiSwap, ApeSwap, Dfyn |

## Resumo

- **Pares encontrados**: 4
- **CAS remanescente total**: 7605.900719623457037314 CAS
- **CAS remanescente (wei)**: 7605900719623457037314

## Pares encontrados

| DEX | Par LP | Outro token | CAS reserva | Outra reserva | Preço (CAS/outro) | LP total |
|---|---|---|---|---|---|---|
| SushiSwap | 0x265D86d4D43c32037b032097e8bFB6893E1C3964 | WPOL | 7258.819052276038436665 | 73.603942872453561034 POL | 98.619976 | 707.1067811865475244 |
| Dfyn | 0x2275BFC0b1E26fB36a42E26fA1E5e4D823E62bc3 | WETH | 149.664099942891093026 | 1.870351387760257168 WETH | 80.019242 | 7.071067811865475244 |
| ApeSwap | 0xF27F3c3E305FEdf21B491A1d531fd4c3c80312B4 | WPOL | 141.735818329984518538 | 1.567190266846388254 POL | 90.439445 | 7.071067811865475244 |
| QuickSwap | 0xf77BD26fE17adb1bC99BE6Cd63414b2A7819690E | WPOL | 55.681749074542989085 | 0.828050148181067493 POL | 67.244417 | 0.007365248147542641 |

## Dados brutos

```json
{
  "timestamp": "2026-07-27T02:50:59.047Z",
  "network": "Polygon PoS Mainnet",
  "chainId": 137,
  "blockNumber": 90943781,
  "casToken": "0x5151A34EaC7bA08cd6B540b32cD30316218A2287",
  "totalCasRemaining": "7605900719623457037314",
  "totalCasFormatted": "7605.900719623457037314",
  "pairs": [
    {
      "dex": "SushiSwap",
      "factory": "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
      "pair": "0x265D86d4D43c32037b032097e8bFB6893E1C3964",
      "token0": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      "token1": "0x5151A34EaC7bA08cd6B540b32cD30316218A2287",
      "isCas0": false,
      "otherToken": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      "otherSymbol": "WPOL",
      "otherDecimals": 18,
      "casReserve": "7258819052276038436665",
      "otherReserve": "73603942872453561034",
      "totalSupply": "707106781186547524400",
      "price": 98.61997562895056
    },
    {
      "dex": "Dfyn",
      "factory": "",
      "pair": "0x2275BFC0b1E26fB36a42E26fA1E5e4D823E62bc3",
      "token0": "0x4c28f48448720e9000907BC2611F73022fdcE1fA",
      "token1": "0x5151A34EaC7bA08cd6B540b32cD30316218A2287",
      "isCas0": false,
      "otherToken": "0x4c28f48448720e9000907BC2611F73022fdcE1fA",
      "otherSymbol": "WETH",
      "otherDecimals": "18",
      "casReserve": "149664099942891093026",
      "otherReserve": "1870351387760257168",
      "totalSupply": "7071067811865475244",
      "price": 80.01924179718637
    },
    {
      "dex": "ApeSwap",
      "factory": "0xCf083Be4164828f00cAE704EC15a36D711491284",
      "pair": "0xF27F3c3E305FEdf21B491A1d531fd4c3c80312B4",
      "token0": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      "token1": "0x5151A34EaC7bA08cd6B540b32cD30316218A2287",
      "isCas0": false,
      "otherToken": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      "otherSymbol": "WPOL",
      "otherDecimals": 18,
      "casReserve": "141735818329984518538",
      "otherReserve": "1567190266846388254",
      "totalSupply": "7071067811865475244",
      "price": 90.43944524693572
    },
    {
      "dex": "QuickSwap",
      "factory": "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32",
      "pair": "0xf77BD26fE17adb1bC99BE6Cd63414b2A7819690E",
      "token0": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      "token1": "0x5151A34EaC7bA08cd6B540b32cD30316218A2287",
      "isCas0": false,
      "otherToken": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      "otherSymbol": "WPOL",
      "otherDecimals": 18,
      "casReserve": "55681749074542989085",
      "otherReserve": "828050148181067493",
      "totalSupply": "7365248147542641",
      "price": 67.24441653305183
    }
  ]
}
```
