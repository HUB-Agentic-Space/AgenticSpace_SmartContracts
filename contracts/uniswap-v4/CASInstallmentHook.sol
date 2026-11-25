// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

// IERC20 descreve as chamadas que podemos fazer ao token, como balanceOf.
// As interfaces e os tipos do v4 dão a estas funções a mesma assinatura usada pelo PoolManager.
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {CASInstallmentRouter} from "./CASInstallmentRouter.sol";

/// @title Revenda de CAS em duas parcelas nos pools participantes do Uniswap v4
/// @notice Uma compra abre um lote. Para 20.000 CAS, a carteira pode vender 10.000 após 24 horas.
///         As outras 24 horas começam no bloco em que a primeira venda é efetivada.
/// @dev Um hook é um contrato que o PoolManager chama em momentos específicos. Aqui, beforeInitialize
///      confere a origem do novo pool e afterSwap registra uma compra ou valida uma venda. Os tokens
///      vão para a carteira. O que este contrato guarda são quantidades, prazos e direitos de venda.
contract CASInstallmentHook {
    // Permite escrever manager.getSlot0(id) para ler o estado do pool por meio da biblioteca do v4.
    using StateLibrary for IPoolManager;

    // Solidity expressa a duração em segundos. A comparação com o relógio do bloco só acontece
    // quando alguém envia uma transação. Completar 24 horas, por si só, não executa uma ordem.
    uint64 public constant INTERVAL = 1 days;
    // Os quatro endereços immutable são definidos na implantação. PoolManager administra os pools,
    // cas identifica o ERC-20, router identifica quem pode negociar e initializer quem pode inicializar.
    IPoolManager public immutable manager;
    IERC20 public immutable cas;
    CASInstallmentRouter public immutable router;
    address public immutable initializer;
    // O valor padrão de uma entrada de mapping é false. O construtor marca os IDs dos pools de origem.
    mapping(PoolId => bool) public sourceAllowed;

    // As quantidades são inteiros em unidades mínimas do token. Se nextAmount for 10.000 CAS,
    // a ordem deve vender exatamente esses 10.000. lastAmount vira a próxima parcela após a venda.
    struct Lot {
        uint128 nextAmount;
        uint128 lastAmount;
        // Primeiro timestamp Unix, em segundos, em que nextAmount pode ser vendida.
        uint64 sellAfter;
    }

    // Cada carteira tem sua própria numeração, a partir de 1. Como a chave não inclui o pool,
    // o lote que a carteira abriu no CAS/USDC também é encontrado quando ela vende no CAS/WPOL.
    mapping(address => uint256) public lastLotId;
    // Soma de todas as parcelas ainda pendentes da carteira. O saldo real pode variar por transferência.
    mapping(address => uint256) public outstanding;
    // IDs até este número, inclusive, foram descartados pela carteira. Os IDs seguintes continuam válidos.
    mapping(address => uint256) public discardedThrough;
    mapping(address => mapping(uint256 => Lot)) private _lots;

    // revert interrompe a operação e desfaz suas alterações. Os argumentos dos erros permitem à
    // interface mostrar, por exemplo, quanto pode ser registrado, quando vender e qual é a parcela.
    error InvalidConfig();
    error OnlyManager();
    error OnlyInitializer();
    error OnlyRouter();
    error UnsupportedPool();
    error SourcePriceChanged();
    error InvalidAmount();
    error UnregisteredBalance(uint256 available);
    error LotsExceedBalance(uint256 booked, uint256 balance);
    error UnknownLot();
    error TooEarly(uint64 sellAfter);
    error WrongInstallment(uint128 expected);

    /// @notice Anuncia o ID do novo lote e a data da primeira venda. Pool zero indica registro de saldo externo.
    /// @dev Os campos indexed permitem filtrar os logs por carteira, lote ou pool ao ler o recibo da transação.
    event LotOpened(address indexed wallet, uint256 indexed lotId, PoolId indexed pool, uint128 amount, uint64 sellAfter);
    /// @notice Informa a parcela consumida. nextSale igual a zero indica o encerramento do lote.
    event InstallmentSold(address indexed wallet, uint256 indexed lotId, PoolId indexed pool, uint128 amount, uint64 nextSale);
    /// @notice Identifica até qual lote os direitos de venda foram descartados.
    event LotsDiscarded(address indexed wallet, uint256 throughLotId);

    /// @param manager_ Contrato oficial do v4 que fará os callbacks e manterá o estado dos pools.
    /// @param cas_ Token cuja entrada ou saída no swap determina se houve venda ou compra.
    /// @param initializer_ Carteira autorizada a inicializar os pools sucessores, inclusive uma multisig.
    /// @param sourceIds Identificadores completos dos pools de origem, conferidos pelo script de implantação.
    constructor(IPoolManager manager_, IERC20 cas_, address initializer_, PoolId[] memory sourceIds) {
        // As permissões começam como false em memory. O v4 lê os 14 bits inferiores do endereço do
        // hook para escolher seus callbacks. O script busca o endereço por CREATE2 e esta chamada
        // exige que ele tenha exatamente os bits de beforeInitialize e afterSwap.
        Hooks.Permissions memory permissions;
        permissions.beforeInitialize = true;
        permissions.afterSwap = true;
        Hooks.validateHookPermissions(IHooks(address(this)), permissions);
        // code.length confirma a presença de código nos dois endereços de contrato. Também precisamos
        // de um responsável pela inicialização e de pelo menos um pool para o qual a regra fará sentido.
        if (address(manager_).code.length == 0 || address(cas_).code.length == 0 ||
            initializer_ == address(0) || sourceIds.length == 0) revert InvalidConfig();
        manager = manager_;
        cas = cas_;
        initializer = initializer_;
        // Registrar os IDs uma vez permite consultar uma origem diretamente. Uma duplicata aponta
        // para um erro na lista de implantação e faz o construtor reverter.
        for (uint256 i; i < sourceIds.length; ++i) {
            if (sourceAllowed[sourceIds[i]]) revert InvalidConfig();
            sourceAllowed[sourceIds[i]] = true;
        }
        // Ao usar new aqui, o próprio hook é msg.sender no construtor do roteador. Assim cada um
        // conhece o endereço do outro antes de qualquer swap, sem uma etapa posterior de configuração.
        router = new CASInstallmentRouter(manager_);
    }

    /// @notice Valida o novo pool antes que o v4 grave seu preço inicial.
    /// @param sender Endereço que chamou initialize no PoolManager.
    /// @param key Chave do sucessor, com as duas moedas ordenadas, a taxa, o espaçamento de ticks e o hook.
    /// @param price Raiz quadrada do preço inicial na representação inteira Q64.96 do v4.
    /// @return Seletor de quatro bytes que confirma ao PoolManager qual callback respondeu.
    function beforeInitialize(address sender, PoolKey calldata key, uint160 price) external view returns (bytes4) {
        // Há duas chamadas encadeadas. A carteira inicializadora chama o manager (sender),
        // e o manager chama este contrato (msg.sender). Validar as duas preserva essa cadeia.
        if (msg.sender != address(manager)) revert OnlyManager();
        if (sender != initializer) revert OnlyInitializer();
        // Currency.unwrap extrai o endereço da moeda. No v4, endereço zero representa a moeda nativa
        // e, pela ordenação numérica, ela ocuparia currency0. Aqui os dois ativos precisam ser ERC-20,
        // e o CAS pode ocupar qualquer um dos lados.
        if (Currency.unwrap(key.currency0) == address(0) ||
            (Currency.unwrap(key.currency0) != address(cas) && Currency.unwrap(key.currency1) != address(cas))) {
            revert UnsupportedPool();
        }
        // calldata contém a chave recebida e é somente leitura. Copiamos para memory e substituímos
        // apenas o hook. O hash dos cinco campos dessa cópia deve ser o ID de uma origem autorizada.
        PoolKey memory source = key;
        source.hooks = IHooks(address(0));
        PoolId sourceId = source.toId();
        if (!sourceAllowed[sourceId]) revert UnsupportedPool();
        // getSlot0 devolve vários campos. As vírgulas vazias descartam os demais. Para converter
        // sqrtPriceX96 em unidades mínimas de currency1 por unidade mínima de currency0, calcule
        // (sqrtPriceX96 / 2^96) ao quadrado com precisão fracionária. Aqui basta comparar os inteiros.
        (uint160 referencePrice,,,) = manager.getSlot0(sourceId);
        // Uma origem sem preço ou cujo preço mudou desde o plano exige nova conferência.
        // Inicializar define o preço do sucessor. O depósito de liquidez ocorre em outra operação.
        if (referencePrice == 0 || price != referencePrice) revert SourcePriceChanged();
        return IHooks.beforeInitialize.selector;
    }

    /// @notice Calcula quanto do saldo atual a carteira ainda pode transformar em lotes.
    /// @dev Se houver 25.000 CAS e 20.000 já estiverem registrados, sobram 5.000 para registrar.
    ///      Uma transferência pode deixar o saldo abaixo do registrado. Nesse caso retornamos zero
    ///      para evitar uma subtração negativa em uint256. O hook só vê o saldo atual do ERC-20.
    ///      Os prazos acompanham os lotes da carteira. Unidades de CAS não têm número de série,
    ///      então o hook não consegue determinar a idade de cada unidade que compõe esse saldo.
    function registrableBalance(address wallet) public view returns (uint256) {
        uint256 balance = cas.balanceOf(wallet);
        uint256 booked = outstanding[wallet];
        return balance > booked ? balance - booked : 0;
    }

    /// @notice Abre um lote para CAS que já estava na carteira, com a mesma espera aplicada a uma compra.
    /// @return ID do lote do chamador. O registro consulta o saldo e dispensa aprovação para gastar tokens.
    function registerBalance(uint128 amount) external returns (uint256) {
        if (amount == 0) revert InvalidAmount();
        uint256 available = registrableBalance(msg.sender);
        if (amount > available) revert UnregisteredBalance(available);
        // PoolId.wrap dá o tipo PoolId ao valor zero de 32 bytes. No evento, esse valor distingue o
        // registro voluntário de um lote aberto por um swap, que leva o identificador do pool.
        return _open(msg.sender, amount, PoolId.wrap(bytes32(0)));
    }

    /// @notice Lê uma cópia do lote sem modificar o registro. Três zeros representam um lote inativo.
    function lots(address wallet, uint256 id) external view returns (Lot memory) {
        // Um ID anterior ao descarte pode continuar gravado fisicamente. O limite o torna inválido.
        // Para um ID que nunca existiu ou que já foi apagado, o próprio mapping devolve campos zerados.
        if (id <= discardedThrough[wallet]) return Lot(0, 0, 0);
        return _lots[wallet][id];
    }

    /// @notice Permite ao titular desistir de todos os direitos pendentes, por exemplo após transferir CAS.
    /// @dev Zeramos o total e marcamos o último ID em duas escritas, independentemente da quantidade
    ///      de lotes. Descartar todos juntos impede escolher apenas a compra nova para reaproveitar
    ///      um direito antigo sem cobertura. Um novo registro recebe ID e prazo próprios.
    function discardAllLots() external {
        if (outstanding[msg.sender] == 0) revert UnknownLot();
        outstanding[msg.sender] = 0;
        discardedThrough[msg.sender] = lastLotId[msg.sender];
        emit LotsDiscarded(msg.sender, lastLotId[msg.sender]);
    }

    /// @notice Recebe o resultado do swap enquanto o roteador ainda precisa liquidar os tokens.
    /// @dev A assinatura v4 inclui SwapParams. Este hook usa a quantidade efetivamente calculada em
    ///      delta. Reverter neste ponto também desfaz o swap do manager, pois ambos integram a mesma transação.
    function afterSwap(
        address sender, PoolKey calldata key, SwapParams calldata, BalanceDelta delta, bytes calldata hookData
    ) external returns (bytes4, int128) {
        // O manager é quem chama afterSwap. O sender informado por ele é quem chamou manager.swap.
        // Só o roteador fixado no construtor vincula os dados abaixo à carteira que paga e recebe.
        if (msg.sender != address(manager)) revert OnlyManager();
        if (sender != address(router)) revert OnlyRouter();
        (address trader, uint256 lotId) = abi.decode(hookData, (address, uint256));
        // BalanceDelta contém dois inteiros com sinal, um para cada moeda, na perspectiva do roteador.
        // CAS positivo é crédito a receber do manager (compra). CAS negativo é dívida a pagar (venda).
        int128 casDelta = Currency.unwrap(key.currency0) == address(cas) ? delta.amount0() : delta.amount1();
        if (casDelta > 0) {
            // Na compra, zero indica que será criado um novo ID. Outra compra da mesma carteira
            // abre outro lote, de modo que o relógio do primeiro continua correndo.
            if (lotId != 0) revert UnknownLot();
            _open(trader, uint128(casDelta), key.toId());
        } else if (casDelta < 0) {
            // Alargamos para int256 antes de trocar o sinal. O módulo do menor int128 cabe em
            // int256 e em uint128, mas excederia o maior int128 positivo.
            _sell(trader, lotId, uint128(uint256(-int256(casDelta))), key.toId());
        } else {
            // Um delta zero não fornece quantidade para abrir um lote nem para pagar uma parcela.
            revert InvalidAmount();
        }
        // O seletor identifica o callback esperado. O segundo valor é o ajuste de saldo do hook.
        // Zero deixa todo o resultado do swap para o roteador liquidar em nome da carteira.
        return (IHooks.afterSwap.selector, 0);
    }

    /// @dev Compras e registros manuais usam a mesma função privada para calcular parcelas e vencimento.
    function _open(address wallet, uint128 amount, PoolId pool) private returns (uint256 id) {
        // O pré-incremento reserva o próximo ID desta carteira antes de usá-lo. A divisão inteira
        // arredonda para baixo. Para cinco unidades mínimas, a segunda parcela vale 2 e a primeira 3.
        id = ++lastLotId[wallet];
        uint128 second = amount / 2;
        uint64 sellAfter = uint64(block.timestamp + INTERVAL);
        // Guardamos as duas parcelas e somamos o lote inteiro ao total comprometido da carteira.
        // A interface pode recuperar o ID e a data pelo evento mesmo após o fim da chamada.
        _lots[wallet][id] = Lot(amount - second, second, sellAfter);
        outstanding[wallet] += amount;
        emit LotOpened(wallet, id, pool, amount, sellAfter);
    }

    /// @dev Consome uma parcela integral. pool identifica o local da venda para o evento.
    function _sell(address wallet, uint256 id, uint128 amount, PoolId pool) private {
        // storage aponta para o registro persistente. As verificações precedem qualquer escrita.
        // A igualdade no instante sellAfter já permite vender. Uma venda menor também reverte,
        // pois cada parcela corresponde a uma única execução integral.
        Lot storage lot = _lots[wallet][id];
        if (lot.nextAmount == 0 || id <= discardedThrough[wallet]) revert UnknownLot();
        if (block.timestamp < lot.sellAfter) revert TooEarly(lot.sellAfter);
        if (amount != lot.nextAmount) revert WrongInstallment(lot.nextAmount);
        // O débito ERC-20 ocorrerá depois deste callback. Exigimos saldo para TODOS os lotes pendentes
        // antes da venda. Isso protege o saldo de uma compra nova caso o titular já tenha transferido
        // os tokens de um lote antigo. Como CAS é fungível, esta checagem mede cobertura atual.
        uint256 booked = outstanding[wallet];
        uint256 balance = cas.balanceOf(wallet);
        if (balance < booked) revert LotsExceedBalance(booked, balance);
        outstanding[wallet] = booked - amount;
        // nextSale começa em zero. Se esta era a última parcela, delete zera o registro e o zero
        // no evento comunica seu encerramento. O contador de IDs da carteira continua crescente.
        uint64 nextSale;
        if (lot.lastAmount == 0) {
            delete _lots[wallet][id];
        } else {
            // Se a compra foi na segunda às 10h e a primeira venda na terça às 16h, a segunda só
            // estará disponível na quarta às 16h. Usamos o bloco da venda efetiva para iniciar a espera.
            nextSale = uint64(block.timestamp + INTERVAL);
            lot.nextAmount = lot.lastAmount;
            lot.lastAmount = 0;
            lot.sellAfter = nextSale;
        }
        emit InstallmentSold(wallet, id, pool, amount, nextSale);
    }
}
