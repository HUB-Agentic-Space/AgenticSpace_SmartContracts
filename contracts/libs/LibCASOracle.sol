// SPDX-License-Identifier: CC-BY-SA-4.0
// Author:   Carlos Delfino
// Email:    consultoria@carlosdelfino.eti.br
// WhatsApp: +55 (85) 98520-5490
pragma solidity 0.8.28;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { CASSwapStorage } from "../diamond/storage/CASSwapStorage.sol";

/**
 * @title LibCASOracle
 * @dev Derivação on-chain dos ratios CAS <-> ativo de cotação a partir de
 *      oráculos, substituindo os ratios armazenados mantidos pelo agente
 *      off-chain. Fontes:
 *
 *      - CAS/WPOL: envelope min/max entre o TWAP do pool Uniswap V3
 *        (`observe`) e o TWAP acumulado do par SushiSwap V2
 *        (`price0/1CumulativeLast` com âncora própria no storage). O spread
 *        entre as fontes define o envelope: quem compra CAS paga o preço
 *        mais caro (menos CAS por cotação), quem vende recebe o mais barato
 *        (mais CAS por cotação) — a diferença fica no contrato.
 *      - Ativos de cotação em USD: feeds Chainlink POL/USD, USDC/USD e
 *        USD/BRL (BRLA é paridade 1:1 com BRL). POL não precisa de feed para
 *        a própria perna — CAS/POL sai direto do envelope CAS/WPOL.
 *
 *      Semântica mantida: num/den = CAS (base units) por base unit do ativo.
 *
 *      Padrões: Library (Solidity), Strategy (fonte de preço), Fallback
 *      (ratio legado quando o oráculo está indisponível).
 */
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface IUniswapV2PairOracle {
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

interface IUniswapV3PoolOracle {
    function observe(uint32[] calldata secondsAgos)
        external view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function liquidity() external view returns (uint128);
}

/// @dev token0/token1 existem em pares V2 e pools V3 — usado para detectar
///      a posição do CAS em cada fonte na configuração do oráculo.
interface IUniswapV2PairTokens {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

library LibCASOracle {
    uint256 internal constant E18 = 1e18;
    uint256 internal constant Q112 = 1 << 112;
    uint256 internal constant Q192 = 1 << 192;

    // Currency ids (mesmos de LibCASSwap): 0=POL, 1=USDC, 2=BRLA, 3=CAS.
    uint8 internal constant CURRENCY_POL = 0;
    uint8 internal constant CURRENCY_USDC = 1;
    uint8 internal constant CURRENCY_BRLA = 2;

    /// @notice Emitido quando um novo TWAP SushiSwap é publicado e a âncora
    ///         da janela é movida.
    event CasTwapPublished(uint256 casPerWpolE18, uint32 windowSeconds, uint32 at);

    /// @notice Lê um feed Chainlink e devolve o preço em USD escalado 1e18.
    /// @dev Retorna 0 quando o feed não está configurado, está stale ou
    ///      devolveu resposta inválida — os callers tratam 0 como
    ///      "fonte indisponível", nunca como preço.
    function usdPriceE18(address feed, uint256 maxStale) internal view returns (uint256) {
        if (feed == address(0)) return 0;
        try IAggregatorV3(feed).decimals() returns (uint8 dec) {
            if (dec == 0 || dec > 36) return 0;
            try IAggregatorV3(feed).latestRoundData() returns (
                uint80, int256 answer, uint256, uint256 updatedAt, uint80
            ) {
                if (answer <= 0) return 0;
                if (updatedAt == 0 || updatedAt > block.timestamp) return 0;
                if (maxStale != 0 && block.timestamp - updatedAt > maxStale) return 0;
                return Math.mulDiv(uint256(answer), E18, 10 ** dec);
            } catch {
                return 0;
            }
        } catch {
            return 0;
        }
    }

    /// @notice TWAP CAS/WPOL do pool Uniswap V3 via `observe`.
    /// @dev Retorna CAS por WPOL escalado 1e18, ou 0 quando indisponível
    ///      (pool não configurado, sem liquidez — tick congelado — ou
    ///      `observe` reverte por cardinalidade insuficiente).
    function uniV3CasPerWpolE18(CASSwapStorage.Data storage s) internal view returns (uint256) {
        address pool = s.uniV3CasPool;
        if (pool == address(0) || s.casTwapWindow == 0) return 0;
        if (IUniswapV3PoolOracle(pool).liquidity() == 0) return 0;
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = s.casTwapWindow;
        secondsAgos[1] = 0;
        try IUniswapV3PoolOracle(pool).observe(secondsAgos) returns (int56[] memory cums, uint160[] memory) {
            int56 delta = cums[1] - cums[0];
            int24 tick = int24(delta / int56(uint56(s.casTwapWindow)));
            // Arredonda para baixo em módulo (o tick médio é truncado, e a
            // divisão de int56 em Solidity já trunca para zero — aceitável
            // porque ambas as pontas do envelope sofrem o mesmo deslocamento).
            uint160 sqrtRatio = _sqrtRatioX96(tick);
            // preço raw = token1/token0 (ambos 18 decimais) = CAS por WPOL.
            uint256 rawE18 = Math.mulDiv(Math.mulDiv(sqrtRatio, sqrtRatio, 1), E18, Q192);
            if (s.uniCasIsToken1) return rawE18;
            if (rawE18 == 0) return 0;
            return Math.mulDiv(E18, E18, rawE18);
        } catch {
            return 0;
        }
    }

    /// @notice TWAP CAS/WPOL do par SushiSwap V2 a partir dos cumulativos.
    /// @dev A âncora é o último checkpoint; quando `elapsed >= casTwapWindow`
    ///      o TWAP da janela é computado on-the-fly (leitura view). Abaixo da
    ///      janela, usa o último TWAP publicado por `pokeCasTwap` se ainda
    ///      estiver dentro de `casTwapWindow * 4` de idade. Retorna CAS por
    ///      WPOL escalado 1e18, ou 0 quando indisponível.
    function sushiCasPerWpolE18(CASSwapStorage.Data storage s) internal view returns (uint256) {
        if (s.sushiCasPair == address(0) || s.sushiAnchorTs == 0 || s.casTwapWindow == 0) return 0;
        uint256 cumNow = _sushiCumulative(s);
        uint256 elapsed = block.timestamp - s.sushiAnchorTs;
        if (elapsed >= s.casTwapWindow && cumNow > s.sushiAnchorCum) {
            return _decodeUq112E18(cumNow - s.sushiAnchorCum, elapsed);
        }
        uint256 maxStale = uint256(s.casTwapWindow) * 4;
        if (s.sushiTwapE18 != 0 && block.timestamp - s.sushiTwapTs <= maxStale) {
            return s.sushiTwapE18;
        }
        return 0;
    }

    /// @notice Publica o TWAP do par SushiSwap quando a janela fecha e move a
    ///         âncora. Chamado no início de todo swap não-view e exposto pelo
    ///         facet como `updateCasTwap()` (permissionless). Idempotente:
    ///         fora da janela é no-op; na primeira chamada só ancora.
    function pokeCasTwap(CASSwapStorage.Data storage s) internal {
        if (s.sushiCasPair == address(0) || s.casTwapWindow == 0) return;
        uint256 cumNow = _sushiCumulative(s);
        if (s.sushiAnchorTs == 0) {
            s.sushiAnchorCum = cumNow;
            s.sushiAnchorTs = uint32(block.timestamp);
            return;
        }
        uint256 elapsed = block.timestamp - s.sushiAnchorTs;
        if (elapsed < s.casTwapWindow || cumNow <= s.sushiAnchorCum) return;
        s.sushiTwapE18 = _decodeUq112E18(cumNow - s.sushiAnchorCum, elapsed);
        s.sushiTwapTs = uint32(block.timestamp);
        s.sushiAnchorCum = cumNow;
        s.sushiAnchorTs = uint32(block.timestamp);
        emit CasTwapPublished(s.sushiTwapE18, s.casTwapWindow, uint32(block.timestamp));
    }

    /// @notice Ratio CAS/ativo (num/den em base units) derivado do oráculo.
    /// @dev `sell=false` (buy) usa o CAS mais caro do envelope (menos CAS por
    ///      ativo); `sell=true` usa o mais barato. Retorna ok=false quando a
    ///      combinação de fontes necessária ao ativo está indisponível — o
    ///      caller decide se cai para o ratio legado.
    function casRatio(
        CASSwapStorage.Data storage s,
        uint8 currency,
        bool sell
    ) internal view returns (uint256 num, uint256 den, bool ok) {
        (uint256 casWpolMin, uint256 casWpolMax) = _casWpolEnvelope(s);
        if (casWpolMin == 0 || casWpolMax == 0) return (0, 0, false);
        uint256 casWpol = sell ? casWpolMax : casWpolMin;

        if (currency == CURRENCY_POL) {
            return (casWpol, E18, true);
        }
        uint256 polUsd = usdPriceE18(s.polUsdFeed, s.clStaleCrypto);
        if (polUsd == 0) return (0, 0, false);

        if (currency == CURRENCY_USDC) {
            uint256 usdcUsd = usdPriceE18(s.usdcUsdFeed, s.clStaleCrypto);
            if (usdcUsd == 0) return (0, 0, false);
            // CAS(18) por USDC(6): CAS/USDC_humano = casWpol * usdcUsd / polUsd,
            // depois escala 1e18/1e6 = 1e12 para base units.
            num = Math.mulDiv(Math.mulDiv(casWpol, usdcUsd, polUsd), 1e12, 1);
            return (num, E18, num != 0);
        }
        if (currency == CURRENCY_BRLA) {
            uint256 brlUsd = usdPriceE18(s.brlUsdFeed, s.clStaleFx);
            if (brlUsd == 0) return (0, 0, false);
            // Feed BRL/USD (USD por BRL; BRLA é paridade 1:1 com BRL).
            // CAS/BRLA_humano = casWpol * brlUsd / polUsd; BRLA tem 18
            // decimais como o CAS — mesmo shape da perna POL.
            uint256 casPerBrla = Math.mulDiv(casWpol, brlUsd, polUsd);
            return (casPerBrla, E18, casPerBrla != 0);
        }
        return (0, 0, false);
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /// @dev Envelope CAS/WPOL: min = mais caro para quem compra CAS,
    ///      max = mais barato para quem vende. Fonte única replica o valor
    ///      nas duas pontas (spread fica na swapFeeBps).
    function _casWpolEnvelope(CASSwapStorage.Data storage s)
        private view returns (uint256 minV, uint256 maxV)
    {
        uint256 a = uniV3CasPerWpolE18(s);
        uint256 b = sushiCasPerWpolE18(s);
        if (a == 0) return (b, b);
        if (b == 0) return (a, a);
        return a < b ? (a, b) : (b, a);
    }

    /// @dev Cumulativo bruto atual do par SushiSwap (expõe o interno para o
    ///      facet ancorar a janela na configuração do oráculo).
    function sushiCumulativeNow(CASSwapStorage.Data storage s) internal view returns (uint256) {
        return _sushiCumulative(s);
    }

    function _sushiCumulative(CASSwapStorage.Data storage s) private view returns (uint256) {
        return s.sushiCasIsToken1
            ? IUniswapV2PairOracle(s.sushiCasPair).price0CumulativeLast()
            : IUniswapV2PairOracle(s.sushiCasPair).price1CumulativeLast();
    }

    /// @dev Decodifica um delta de cumulativo UQ112.112 em CAS/WPOL × 1e18.
    function _decodeUq112E18(uint256 cumDelta, uint256 elapsed) private pure returns (uint256) {
        return Math.mulDiv(cumDelta, E18, elapsed * Q112);
    }

    /// @dev TickMath.getSqrtRatioAtTick (Uniswap V3) — versão compacta para o
    ///      range de ticks de CAS/WPOL. Precondição: |tick| <= 887272.
    function _sqrtRatioX96(int24 tick) private pure returns (uint160) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        require(absTick <= 887272, "T");
        uint256 ratio = absTick & 1 != 0
            ? 0xfffcb933bd6fad37aa2d162d1a594001
            : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcfd86d09f11c135dd48722358e8a169) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
        if (tick > 0) ratio = type(uint256).max / ratio;
        return uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }
}
