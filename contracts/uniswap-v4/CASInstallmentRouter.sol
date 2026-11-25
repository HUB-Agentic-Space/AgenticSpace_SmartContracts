// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

// IERC20 e SafeERC20 tratam da movimentação real dos tokens. As interfaces do v4 tratam do cálculo
// do swap e das quantidades que o roteador precisa pagar ou receber durante a mesma transação.
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title Roteador de swaps para os pools de CAS com venda em parcelas
/// @notice Troca um ERC-20 por outro em um único pool. A carteira que chama swap paga a entrada e recebe a saída.
/// @dev Comece a leitura por swap. A carteira chama o roteador, o roteador chama manager.unlock e o
///      manager chama unlockCallback neste mesmo contrato. Dentro do callback, manager.swap consulta o
///      hook. Só depois o roteador paga a moeda de entrada e pede ao manager a entrega da moeda de saída.
contract CASInstallmentRouter is IUnlockCallback {
    // Acrescenta safeTransferFrom à interface IERC20. A biblioteca trata tokens que devolvem false
    // como falha e aceita ERC-20 compatíveis que concluem a transferência sem devolver um booleano.
    using SafeERC20 for IERC20;

    // Estes dois endereços são fixados durante a construção. Isso permite verificar tanto o manager
    // que retorna o callback quanto o hook que acompanha a chave do pool em cada ordem.
    IPoolManager public immutable manager;
    address public immutable hook;

    // Os erros distinguem ordem vencida, quantidade incompleta, preço fora do limite e diferença
    // no pagamento efetivo. Qualquer uma dessas falhas reverte a ordem e a atualização do lote.
    error UnsupportedPool();
    error InvalidAmount();
    error Expired();
    error OnlyManager();
    error PartialFill();
    error SlippageExceeded();
    error IncorrectPayment();

    constructor(IPoolManager manager_) {
        manager = manager_;
        // O construtor do CASInstallmentHook executa new CASInstallmentRouter. Nesta chamada
        // msg.sender identifica o hook, inclusive quando uma factory implantou o próprio hook.
        hook = msg.sender;
    }

    /// @notice Envia a ordem ao v4 e devolve as quantidades efetivamente pagas e recebidas.
    /// @param key Chave completa do pool participante, incluindo o endereço do hook associado ao roteador.
    /// @param zeroForOne true gasta currency0 e recebe currency1. false faz o caminho inverso.
    /// @param amountSpecified Negativo fixa a entrada (exact input). Positivo fixa a saída (exact output).
    /// @param limit Com entrada fixa, mínimo a receber. Com saída fixa, máximo a pagar. Ambos em unidades mínimas.
    /// @param lotId Zero abre um lote de compra. Para vender, informe o ID do lote da própria carteira.
    /// @param deadline Último timestamp do bloco em que a carteira aceita executar esta ordem, em segundos Unix.
    /// @return amountIn Total da moeda de entrada que saiu da carteira.
    /// @return amountOut Total da moeda de saída que o manager enviou à carteira.
    function swap(
        PoolKey calldata key, bool zeroForOne, int128 amountSpecified,
        uint128 limit, uint256 lotId, uint256 deadline
    ) external returns (uint256 amountIn, uint256 amountOut) {
        // deadline pertence à cotação desta ordem. sellAfter, conferido pelo hook, pertence ao lote.
        // Uma parcela pode estar liberada e, mesmo assim, a cotação já ter expirado.
        if (block.timestamp > deadline) revert Expired();
        if (amountSpecified == 0 || limit == 0) revert InvalidAmount();
        // O v4 ordena moedas por endereço. Uma moeda nativa ocuparia currency0 com endereço zero.
        // Este roteador liquida por transferFrom e por isso atende pares ERC-20, incluindo CAS/WPOL.
        if (address(key.hooks) != hook || Currency.unwrap(key.currency0) == address(0)) revert UnsupportedPool();
        // Gravamos msg.sender no pacote ABI enquanto ele ainda é a carteira. Dentro de unlockCallback,
        // msg.sender será o manager. abi.encode preserva a identidade e os parâmetros nesse percurso.
        // unlock abre a contabilidade temporária do v4 e chama o callback de forma síncrona.
        bytes memory result = manager.unlock(abi.encode(msg.sender, key, zeroForOne, amountSpecified, limit, lotId));
        // O manager devolve os bytes produzidos pelo callback. Outro contrato, ou uma carteira
        // simulando a chamada, pode ler os dois inteiros. Na transação minerada, os eventos ficam no recibo.
        return abi.decode(result, (uint256, uint256));
    }

    /// @notice Executa e liquida a ordem durante a janela aberta por PoolManager.unlock.
    /// @param data Parâmetros empacotados por swap. A ordem e os tipos devem coincidir na decodificação.
    /// @return Resultado codificado para o caminho de volta até swap.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        // O callback é external porque outro contrato o chama. Verificar o chamador antes de ler
        // data garante que a carteira gravada pelo roteador pertence à execução iniciada com unlock.
        if (msg.sender != address(manager)) revert OnlyManager();
        (address trader, PoolKey memory key, bool zeroForOne, int128 specified, uint128 limit, uint256 lotId) =
            abi.decode(data, (address, PoolKey, bool, int128, uint128, uint256));
        SwapParams memory params = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: specified,
            // O v4 exige limites estritamente dentro do intervalo de TickMath. Usar o extremo
            // válido na direção da troca permite percorrer a liquidez. O limite econômico do
            // usuário será aplicado sobre os valores efetivos logo após o cálculo do swap.
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        // O manager encaminha trader e lotId ao afterSwap do hook. Quando esta linha retorna, o
        // hook já validou ou abriu o lote. O dinheiro ainda será liquidado no bloco de código abaixo.
        BalanceDelta delta = manager.swap(key, params, abi.encode(trader, lotId));
        // O delta reflete a perspectiva do roteador. No CAS/USDC, USDC ocupa currency0.
        // Comprar CAS gera amount0 negativo (USDC a pagar) e amount1 positivo (CAS a receber).
        int128 inputDelta = zeroForOne ? delta.amount0() : delta.amount1();
        int128 outputDelta = zeroForOne ? delta.amount1() : delta.amount0();
        if (inputDelta >= 0 || outputDelta <= 0) revert PartialFill();
        // O ERC-20 trabalha com valores sem sinal. Após verificar os sinais, alargamos a entrada
        // para int256 antes da negação, de modo a comportar até o módulo do menor int128.
        uint256 amountIn = uint256(-int256(inputDelta));
        uint256 amountOut = uint128(outputDelta);
        if (specified < 0) {
            // Na entrada fixa, gastar menos que o especificado é execução parcial. A saída também deve
            // atingir o mínimo escolhido. Por exemplo, quem vende uma parcela fixa aqui o CAS a gastar.
            if (amountIn != uint256(-int256(specified))) revert PartialFill();
            if (amountOut < limit) revert SlippageExceeded();
        } else {
            // Na saída fixa, receber menos que o solicitado também é execução parcial. Por exemplo,
            // para comprar 20.000 CAS, fixe essa saída e informe em limit o máximo aceitável da outra moeda.
            if (amountOut != uint128(specified)) revert PartialFill();
            if (amountIn > limit) revert SlippageExceeded();
        }

        Currency input = zeroForOne ? key.currency0 : key.currency1;
        // sync memoriza o saldo ERC-20 do manager ANTES da transferência. A diferença de saldo
        // permitirá medir o que o manager realmente recebeu, ainda que outros pools usem a mesma moeda.
        manager.sync(input);
        // O trader precisa ter aprovado este roteador para gastar a entrada. O roteador é o
        // gastador autorizado, trader é o dono do saldo e o PoolManager é o destino do pagamento.
        IERC20(Currency.unwrap(input)).safeTransferFrom(trader, address(manager), amountIn);
        // settle credita a diferença medida na moeda sincronizada. Conferir o total evita
        // considerar quitada uma dívida de 100 se, por exemplo, só 99 chegaram ao manager.
        if (manager.settle() != amountIn) revert IncorrectPayment();
        // take consome o crédito de saída do roteador e entrega os tokens diretamente ao trader.
        // Ao terminar unlock, o manager exige que todos os deltas pendentes tenham sido zerados.
        // Se o pagamento ou a entrega falhar, até o registro feito em afterSwap é desfeito.
        manager.take(zeroForOne ? key.currency1 : key.currency0, trader, amountOut);
        return abi.encode(amountIn, amountOut);
    }
}
