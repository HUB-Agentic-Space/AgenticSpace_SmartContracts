// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title CASSwapStorage
 * @dev Diamond Storage namespace for the CAS <-> USDC / POL swap facet
 *      (Rapport Trader). Stores token references, os ratios controlados
 *      pelo backend (off-chain), configuração de fee, estado de pausa e a
 *      configuração de governança/orçamento usada pelo suporte de preço.
 *
 *      IMPORTANTE: o contrato é um INSTRUMENTO. Todo o cálculo do ratio
 *      (filtro IQR, média ponderada, série histórica, Granite TTM/GARCH) é
 *      feito off-chain no operador; aqui apenas armazenamos e aplicamos o
 *      valor recebido via setSwapRatio/setSwapRatioUSDC.
 *
 *      Ratio semantics: `num/den` = quantidade de CAS (base units) por 1
 *      unidade (base units) da moeda de cotação. O backend codifica os
 *      decimais (CAS=18, POL=18, USDC=6) diretamente em num/den.
 *
 *      Slot isolado dos demais facets do Agentic Space:
 *      keccak256("agenticspace.casswap.usdcpol.storage")
 *
 *      Padrões: Diamond Storage (EIP-2535), Memento (state persistence)
 */
library CASSwapStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agenticspace.casswap.usdcpol.storage");

    struct Data {
        // --- Tokens ---
        IERC20 casToken;   // CAS (ERC-20, 18 decimais)
        IERC20 usdcToken;  // USDC nativo Polygon (ERC-20, 6 decimais)

        // --- Ratios (definidos pelo backend, num/den) ---
        uint256 ratioPolNum;   // CAS por POL — numerador
        uint256 ratioPolDen;   // CAS por POL — denominador
        uint256 ratioUsdcNum;  // CAS por USDC — numerador
        uint256 ratioUsdcDen;  // CAS por USDC — denominator

        // --- Fee ---
        uint256 swapFeeBps;    // taxa de swap em basis points (0 = sem taxa)

        // --- Estado ---
        bool paused;
        bool initialized;

        // --- Governança / orçamento (suporte de preço / DCA) ---
        uint256 monthlyBudgetUsdc;  // teto de gasto de suporte por período (USDC base units)
        uint256 maxImpactBps;       // impacto máximo por operação (bps)
        uint256 slippageLimitBps;   // limite de slippage padrão (bps)
        uint256 periodStart;        // início do período de orçamento atual (timestamp)
        uint256 periodSpent;        // gasto no período atual (USDC base units)
        uint256 periodDuration;     // duração do período em segundos (default 30 dias)

        // --- Sell ratios (spread assimétrico) — appendado ao final para
        //     preservar o layout de storage dos facets já deployados ---
        // Se zero, cai para o buy ratio (compatibilidade com versões anteriores)
        uint256 ratioPolSellNum;  // CAS por POL (sell) — numerador
        uint256 ratioPolSellDen;  // CAS por POL (sell) — denominador
        uint256 ratioUsdcSellNum; // CAS por USDC (sell) — numerador
        uint256 ratioUsdcSellDen; // CAS por USDC (sell) — denominador
    }

    function layout() internal pure returns (Data storage s) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
