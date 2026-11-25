# Revenda de CAS em duas parcelas no Uniswap v4

Uma compra entrega CAS diretamente à carteira que pagou. Nos cinco pools participantes, cada compra abre um lote individual. O comprador pode fazer a primeira venda 24 horas depois e a segunda 24 horas depois da execução da primeira. Os horários usam o timestamp do bloco. O hook não agenda ordens nem garante preço, liquidez ou execução futura.

## Exemplo com 20.000 CAS

| Operação | Horário do bloco | Efeito |
| --- | --- | --- |
| Comprar no CAS/USDC | Segunda, 10h | A carteira recebe 20.000 CAS e o hook abre o lote 1. |
| Tentar vender 10.000 no CAS/WPOL | Terça, 9h59 | A transação reverte. O lote continua intacto. |
| Vender 10.000 no CAS/WETH | Terça, 16h | A primeira parcela é consumida. |
| Vender os demais 10.000 no CAS/BRLA | A partir de quarta, 16h | A segunda parcela encerra o lote. |

Cada venda usa o **valor integral da parcela**, em unidades mínimas do CAS. Quando a quantidade é ímpar, a primeira parcela recebe a unidade excedente. Uma compra posterior abre outro lote. Uma carteira pode vender parcelas vencidas de lotes diferentes no mesmo dia. Mesmo após uma longa espera, as duas parcelas de um lote continuam separadas por 24 horas entre as vendas.

## CAS existente ou recebido por transferência

1. A carteira chama `hook.registerBalance(quantidade)`. O hook consulta `CAS.balanceOf`, desconta a quantidade já registrada e abre um lote. O registro dispensa aprovação e custódia.
2. A partir de 24 horas, a carteira vende a primeira parcela pelo roteador. O identificador do lote está no evento `LotOpened`, junto do primeiro horário de venda.
3. A transferência ERC-20 move o saldo. Os direitos de venda do titular anterior continuam vinculados ao endereço que os registrou. Uma carteira receptora sem lote precisa registrar o saldo e cumprir o prazo.
4. Se o saldo ficar abaixo do total dos lotes pendentes, a carteira pode repor a diferença ou chamar `discardAllLots()` e registrar novamente o saldo disponível. O descarte é voluntário, invalida **todos os lotes pendentes daquela carteira** e não movimenta tokens. O novo registro inicia outra contagem.

São direitos por carteira sobre um ativo fungível. O hook verifica saldo no registro e na venda, mas não consegue provar posse contínua entre os dois momentos. Uma carteira que já tem um lote maduro e saldo suficiente pode usar esse direito. Swaps em outros pools e DEXs, transferências P2P e operações de liquidez seguem suas próprias regras.

## Pools de origem na Polygon PoS

No bloco 97.905.310, as cinco chaves abaixo tinham taxa de 0,30%, espaçamento de ticks 60 e endereço de hook zero. O inventário lê `PositionManager.poolKeys`, recalcula o hash completo da chave e confirma inicialização e liquidez ativa no `StateView`, no mesmo bloco.

| Par | PoolId atual |
| --- | --- |
| CAS/USDC | `0x184f2790d70b20af6130f87e22ef832693ff589148310b5482a0e749b9c3a76f` |
| CAS/USDT | `0xe92c05c0729dc356b7dd4e2114ace9ff39ed3cb73b150c32a705ce5c8a63ef1f` |
| CAS/WPOL | `0xe734da5beaea37909294fc34be04f7a677265ec9795ee8a399ae9bdff3aa637d` |
| CAS/WETH | `0xf7b92470206a71c0fc1086e5d2776724cbaa5e283dc99c1a2312dc44d9e755d3` |
| CAS/BRLA | `0x448c14123033f44cbb363d0a812b985b2c2b297648dbaba3d1df7434a14e04cb` |

O endereço do hook integra a `PoolKey`. Mudá-lo produz outro `PoolId`. O script cria cinco sucessores no mesmo `PoolManager`, com as moedas, taxa, espaçamento e preço inicial de cada origem. A inicialização cria um pool com liquidez zero. Para colocar o sucessor em operação, o provedor abre uma posição com a **nova PoolKey**, define faixa, quantidades e mínimos e deposita liquidez. Para reaproveitar capital da posição antiga, seu titular precisa retirar a parcela de liquidez desejada daquela posição. Os NFTs de posição existentes continuam associados aos IDs originais. [Hooks](https://developers.uniswap.org/docs/protocols/v4/concepts/hooks) · [Deployments da Polygon](https://developers.uniswap.org/docs/protocols/v4/deployments#polygon-137)

## Contratos e integração da carteira

- `CASInstallmentHook` guarda lotes em tempo constante por operação. O callback `afterSwap` usa a variação efetiva de CAS e identifica se houve compra ou venda nos dois ordenamentos das moedas. Uma reversão desfaz o swap e todas as alterações do lote.
- `CASInstallmentRouter` faz swaps diretos entre os dois ERC-20 de cada pool. O chamador paga e recebe a saída. O hook aceita apenas o roteador criado no construtor. Isso vincula o lote à carteira que negociou, inclusive quando ela é uma smart account. A interface do projeto deve enviar a ordem por esse endereço. Rotas genéricas do Universal Router, agregadores e o Quoter oficial não executam esse callback autenticado. Uma simulação pelo próprio roteador com `swap.staticCall` reproduz as checagens de saldo e aprovação.
- As permissões v4 são `beforeInitialize` e `afterSwap` (bits inferiores `0x2040`). A carteira inicializadora pode criar os cinco sucessores. Os prazos, parcelas, roteador e lista de origens são fixados no deploy. A integração usa somente a interface ERC-20 do CAS.

Uma ordem chama `router.swap(key, zeroForOne, amountSpecified, limit, lotId, deadline)`. Um valor negativo de `amountSpecified` fixa a entrada e exige saída mínima. Um valor positivo fixa a saída e limita a entrada. O roteador exige preenchimento integral. O CAS/USDC tem USDC como `currency0` e CAS como `currency1`.

| Ação no CAS/USDC | zeroForOne | amountSpecified | limit | lotId |
| --- | --- | --- | --- | --- |
| Comprar exatamente 20.000 CAS | `true` | `+20000 × 10¹⁸` | Máximo de USDC aceito, em unidades de 10⁻⁶ USDC | `0` |
| Vender uma parcela de 10.000 CAS | `false` | `−10000 × 10¹⁸` | Mínimo de USDC aceito, em unidades de 10⁻⁶ USDC | ID de `LotOpened` |

O usuário aprova o roteador no token de entrada para o máximo que aceita gastar, confere `hook.lots(carteira, id)` e assina a ordem com `deadline` em segundos Unix. O frontend pode exibir `nextAmount`, `lastAmount` e `sellAfter` antes de solicitar a assinatura. O evento `InstallmentSold` informa o horário da parcela seguinte. Um prazo ou limite de preço expirado exige uma nova ordem.

## Preparação e deploy

Use Node 22 e as dependências do lockfile da branch. Em `main`, execute `npm ci`. Em `release/cas-v2`, execute `npm ci --legacy-peer-deps` para respeitar a combinação de dependências LayerZero e ethers dessa versão.

```bash
npm run cas:v4:test
POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com npm run cas:v4:inspect
HARDHAT_FORK_URL=https://polygon.drpc.org npm run cas:v4:fork
```

O primeiro teste usa o bytecode publicado do PoolManager v4. O teste de fork faz deploy e inicialização apenas na rede local Hardhat. O inventário usa apenas RPC de leitura. O plano aceita uma EOA ou Safe como inicializador e pode ser gerado sem chave privada.

```bash
export CAS_V4_INITIALIZER=0x...   # endereço público da EOA ou Safe escolhida
export CAS_V4_PLAN=cas-v4-plan.json
npm run cas:v4:plan
```

O JSON contém o bloco de referência, os IDs antigos e novos, os endereços previstos do hook e roteador, o papel do inicializador implícito no construtor e o calldata de cada transação. Confira o preço de cada origem com uma referência independente antes de financiar uma posição. O preço `sqrtPriceX96` é o valor bruto do pool em Q64.96.

Os comandos seguintes **enviam transações para a Polygon** quando executados com o assinante de deploy configurado no Hardhat. O deploy usa CREATE2 e verifica o código da factory. A inicialização pela CLI requer que o assinante seja o inicializador. Para um Safe, encaminhe a transação de deploy e as cinco chamadas `initialize` do JSON ao fluxo de assinaturas do Safe.

```bash
npm run cas:v4:deploy
npm run cas:v4:initialize
```

As duas etapas podem ser retomadas. A CLI verifica o hook implantado e ignora sucessores já inicializados. Se uma origem mudar de preço antes da sua inicialização, a transação daquela origem reverte. Gere o plano com **outro nome de arquivo** e o mesmo inicializador, confira o novo preço e retome. O endereço CREATE2 depende do bytecode e dos argumentos do construtor. O preço de referência fica fora desses argumentos.

A etapa que habilita negociação é o aporte dos LPs nos novos IDs e o direcionamento da interface para o novo roteador. O roteiro de deploy encerra na inicialização. O script histórico de seed da release usa chaves com hook zero e atende aos pools de origem.

[Interface IHooks](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IHooks.sol) · [Factory CREATE2](https://github.com/Arachnid/deterministic-deployment-proxy)
