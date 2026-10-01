// SPDX-License-Identifier: CC-BY-SA-4.0
// Author:   Carlos Delfino
// Email:    consultoria@carlosdelfino.eti.br
// WhatsApp: +55 (85) 98520-5490
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { CASSwapStorage } from "../diamond/storage/CASSwapStorage.sol";
import { LibCASOracle, IUniswapV2PairTokens } from "../libs/LibCASOracle.sol";

/**
 * @title CASSwapOracleFacet
 * @dev Superfície de administração e observabilidade da precificação por
 *      oráculo do CASSwap (Diamond, mesmo storage de CASSwapUSDCPOLFacet).
 *      Separada do facet de swap para manter ambos abaixo do limite EIP-170:
 *      aqui vivem a configuração das fontes (Chainlink + pools), o poke
 *      permissionless do TWAP e as views de diagnóstico.
 *
 *      Enquanto `oracleEnabled=false`, o swap continua usando os ratios
 *      armazenados pelo fluxo legado — a transição é segura porque o
 *      fallback fica limitado por `legacyRatioMaxAge`.
 *
 *      Padrões: Diamond Storage (EIP-2535), Admin/Config separation.
 */
contract CASSwapOracleFacet {
    error InvalidOraclePair(address pair);

    event OracleConfigUpdated(
        address indexed polUsdFeed,
        address indexed usdcUsdFeed,
        address brlUsdFeed,
        address uniV3CasPool,
        address sushiCasPair,
        address indexed updater
    );
    event OraclePricingToggled(bool enabled, address indexed updater);

    /**
     * @notice Configura as fontes de oráculo do swap. Apenas owner (Timelock
     *         via diamondCut initCalldata, ou governança).
     * @dev    A ordem de token de cada par/pool é detectada on-chain contra
     *         `casToken` — reverter quando o par não contém CAS evita
     *         configuração errada silenciosa. A âncora do TWAP SushiSwap é
     *         registrada aqui: a primeira janela fecha `twapWindow` segundos
     *         depois, sem poke prévio. O modo oráculo só é ativado por
     *         `setOracleEnabled(true)` depois do aquecimento.
     */
    function setOracleConfig(
        address polUsdFeed,
        address usdcUsdFeed,
        address brlUsdFeed,
        address uniV3CasPool,
        address sushiCasPair,
        uint32 twapWindow,
        uint32 staleCrypto,
        uint32 staleFx,
        uint32 legacyRatioMaxAge,
        bool enabled
    ) external {
        LibDiamond.enforceIsContractOwner();
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.oracleEnabled = enabled;
        s.polUsdFeed = polUsdFeed;
        s.usdcUsdFeed = usdcUsdFeed;
        s.brlUsdFeed = brlUsdFeed;
        s.casTwapWindow = twapWindow;
        s.clStaleCrypto = staleCrypto;
        s.clStaleFx = staleFx;
        s.legacyRatioMaxAge = legacyRatioMaxAge;

        if (sushiCasPair != address(0)) {
            if (IUniswapV2PairTokens(sushiCasPair).token0() == address(s.casToken)) {
                s.sushiCasIsToken1 = false;
            } else if (IUniswapV2PairTokens(sushiCasPair).token1() == address(s.casToken)) {
                s.sushiCasIsToken1 = true;
            } else {
                revert InvalidOraclePair(sushiCasPair);
            }
            s.sushiCasPair = sushiCasPair;
            s.sushiAnchorCum = LibCASOracle.sushiCumulativeNow(s);
            s.sushiAnchorTs = uint32(block.timestamp);
            s.sushiTwapE18 = 0;
            s.sushiTwapTs = 0;
        } else {
            s.sushiCasPair = address(0);
        }
        if (uniV3CasPool != address(0)) {
            if (IUniswapV2PairTokens(uniV3CasPool).token0() == address(s.casToken)) {
                s.uniCasIsToken1 = false;
            } else if (IUniswapV2PairTokens(uniV3CasPool).token1() == address(s.casToken)) {
                s.uniCasIsToken1 = true;
            } else {
                revert InvalidOraclePair(uniV3CasPool);
            }
            s.uniV3CasPool = uniV3CasPool;
        } else {
            s.uniV3CasPool = address(0);
        }
        emit OracleConfigUpdated(polUsdFeed, usdcUsdFeed, brlUsdFeed, uniV3CasPool, sushiCasPair, msg.sender);
        emit OraclePricingToggled(enabled, msg.sender);
    }

    /// @notice Liga/desliga o modo oráculo. Apenas owner. No modo ligado, os
    ///         ratios armazenados continuam servindo de fallback por
    ///         `legacyRatioMaxAge` segundos desde a última escrita.
    function setOracleEnabled(bool enabled) external {
        LibDiamond.enforceIsContractOwner();
        CASSwapStorage.layout().oracleEnabled = enabled;
        emit OraclePricingToggled(enabled, msg.sender);
    }

    /// @notice Publica o TWAP SushiSwap se a janela fechou; permissionless —
    ///         também roda automaticamente no início de cada swap.
    function updateCasTwap() external {
        LibCASOracle.pokeCasTwap(CASSwapStorage.layout());
    }

    /// @notice Fontes CAS/WPOL ativas agora (escala 1e18). Zeros = indisponível.
    function getCasPriceSources()
        external
        view
        returns (uint256 uniV3CasPerWpol, uint256 sushiCasPerWpol, bool oracleEnabled)
    {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        return (
            LibCASOracle.uniV3CasPerWpolE18(s),
            LibCASOracle.sushiCasPerWpolE18(s),
            s.oracleEnabled
        );
    }

    /// @notice Ratio CAS/ativo efetivo via oráculo (0,0 se indisponível).
    ///         `sell=false` = lado buy (CAS mais caro); `sell=true` = lado
    ///         sell (CAS mais barato). Não aplica o fallback legado.
    function getOracleRatio(uint8 currency, bool sell)
        external
        view
        returns (uint256 num, uint256 den)
    {
        bool ok;
        (num, den, ok) = LibCASOracle.casRatio(CASSwapStorage.layout(), currency, sell);
        if (!ok) return (0, 0);
    }

    function oraclePricingEnabled() external view returns (bool) {
        return CASSwapStorage.layout().oracleEnabled;
    }
}
