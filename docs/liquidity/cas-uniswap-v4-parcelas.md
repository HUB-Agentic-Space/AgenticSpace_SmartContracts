# Revenda de até 50% do saldo remanescente de um lote de CAS no Uniswap v4

Uma compra em um dos cinco pools participantes entrega o CAS diretamente à carteira e abre um lote individual. Após 24 horas, a carteira escolhe quanto vender, até **50% do saldo atual daquele lote**. Cada venda que deixa saldo, mesmo pequena, inicia outras 24 horas de espera. O novo limite considera exatamente o que ficou no lote.

**Exemplo de venda parcial.** Com 21.000 CAS, o primeiro teto é 10.500. Se a carteira vender 3.000 CAS na terça às 16h, ficam 18.000. A partir de quarta às 16h, poderá vender até 9.000. Se escolher vender 8.000, ficam 10.000 e o teto seguinte será 5.000 CAS.

**Exceção para a última venda.** Se vender o máximo de 50% deixaria menos de 5 CAS, o titular pode quitar todo o lote. Uma venda parcial só é válida se deixar pelo menos 5 CAS. O primeiro intervalo de 24 horas também se aplica a um lote pequeno aberto por compra ou registro.

| Saldo do lote | Escolhas em uma rodada liberada |
| ---: | --- |
| 10 CAS | Vender qualquer quantidade positiva até 5 CAS. Vendendo 5, ficam exatamente 5. |
| 9 CAS | Vender até 4 CAS ou vender os 9. Por exemplo, uma ordem de 4,5 CAS deixaria o saldo abaixo do piso e reverte. |
| 5 CAS | Vender os 5 CAS para encerrar. |
| 4,5 CAS | Vender os 4,5 CAS para encerrar. |

## Exemplo com 21.000 CAS

Esta é uma trajetória possível quando a carteira escolhe sempre o máximo, inclusive a quitação final. Se executar cada venda no primeiro instante permitido, cada linha corresponde a outro dia desde a compra. Vendas menores produzem uma sequência diferente.

| Venda | CAS vendidos | CAS que ficam no lote |
| ---: | ---: | ---: |
| 1 | 10.500 | 10.500 |
| 2 | 5.250 | 5.250 |
| 3 | 2.625 | 2.625 |
| 4 | 1.312,5 | 1.312,5 |
| 5 | 656,25 | 656,25 |
| 6 | 328,125 | 328,125 |
| 7 | 164,0625 | 164,0625 |
| 8 | 82,03125 | 82,03125 |
| 9 | 41,015625 | 41,015625 |
| 10 | 20,5078125 | 20,5078125 |
| 11 | 10,25390625 | 10,25390625 |
| 12 | 5,126953125 | 5,126953125 |
| 13 | 5,126953125 | 0 |

Na 12ª venda, a metade que fica ainda supera 5 CAS. Na 13ª, vender metade deixaria 2,5634765625 CAS. A carteira pode vender os 5,126953125 inteiros ou fazer uma venda parcial de até 0,126953125 CAS para preservar o piso de 5.

O contrato calcula em unidades de 10⁻¹⁸ CAS. Se o saldo tem um número ímpar dessas unidades, o teto de 50% arredonda para baixo e a unidade excedente fica no lote. Por exemplo, com 10 CAS menos uma unidade mínima, o teto é 5 CAS menos uma unidade e ainda ficam exatamente 5. Esse detalhe evita liberar a quitação um passo antes.

O prazo pertence ao lote e vale entre os pools participantes. Por exemplo, quem comprar na segunda às 10h no CAS/USDC e fizer a primeira venda na terça às 16h no CAS/WPOL poderá fazer a segunda a partir de quarta às 16h, inclusive no CAS/BRLA. Esperar vários dias libera a próxima parcela. Cada compra posterior abre um lote com seu próprio relógio, então a carteira pode vender parcelas vencidas de lotes diferentes no mesmo dia.

## CAS existente ou recebido por transferência

1. A carteira chama `hook.registerBalance(quantidade)`. O hook consulta `CAS.balanceOf`, desconta a quantidade já registrada e abre um lote. O registro dispensa aprovação e custódia.
2. A partir de 24 horas, a carteira escolhe quanto vender pelo roteador, segundo os mesmos limites de uma compra. O identificador do lote está no evento `LotOpened`, junto do primeiro horário de venda.
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

Uma ordem chama `router.swap(key, zeroForOne, amountSpecified, limit, lotId, deadline)`. Um valor negativo de `amountSpecified` fixa a entrada e exige saída mínima. Um valor positivo fixa a saída e limita a entrada. Quem escolhe vender 3.000 CAS pode enviar uma ordem de entrada fixa por 3.000. O roteador exige o preenchimento integral **da ordem escolhida pelo titular**. Na ordem de saída fixa, o hook verifica quanto CAS a troca efetivamente debita. O CAS/USDC tem USDC como `currency0` e CAS como `currency1`.

| Ação no CAS/USDC | zeroForOne | amountSpecified | limit | lotId |
| --- | --- | --- | --- | --- |
| Comprar exatamente 21.000 CAS | `true` | `+21000 × 10¹⁸` | Máximo de USDC aceito, em unidades de 10⁻⁶ USDC | `0` |
| Escolher vender 3.000 CAS de um lote com teto de 10.500 | `false` | `−3000 × 10¹⁸` | Mínimo de USDC aceito, em unidades de 10⁻⁶ USDC | ID de `LotOpened` |

O usuário aprova o roteador no token de entrada para o máximo que aceita gastar e consulta `hook.lots(carteira, id)`. O campo `nextAmount` informa o maior valor vendável e `lastAmount` o saldo que ficaria **se fosse vendido esse máximo**. A soma dos dois é o saldo atual. O campo `sellAfter` informa o primeiro instante permitido.

- Se `lastAmount > 0`, a interface pode aceitar qualquer valor positivo até `nextAmount`.
- Se `lastAmount == 0` e `nextAmount > 0`, a interface pode oferecer a quitação de `nextAmount`. Se esse saldo superar 5 CAS, também pode oferecer vendas parciais até `nextAmount − 5 CAS`.
- Se os três campos vierem zerados, o lote está inativo.

A carteira assina a ordem com seu próprio `deadline` em segundos Unix. O evento `InstallmentSold` registra a quantidade efetivamente vendida e o próximo horário de venda, ou zero no encerramento. Preço e liquidez disponíveis no momento da ordem também condicionam a execução.

## Preparação e deploy

Use Node 22 e as dependências do lockfile da branch. Em `main`, execute `npm ci`. Em `release/cas-v2`, execute `npm ci --legacy-peer-deps` para respeitar a combinação de dependências LayerZero e ethers dessa versão.

```bash
npm run cas:v4:test
POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com npm run cas:v4:inspect
HARDHAT_FORK_URL=https://polygon.drpc.org npm run cas:v4:fork
```

O primeiro teste usa o bytecode publicado do PoolManager v4. O teste de fork faz deploy e inicialização apenas na rede local Hardhat. O inventário usa apenas RPC de leitura. O plano aceita uma EOA ou Safe como inicializador e pode ser gerado sem chave privada.

Para implantar esta regra, gere um plano com o bytecode desta versão. A revisão muda o endereço CREATE2 do hook, o roteador associado e os IDs dos pools sucessores. Se uma versão anterior tiver sido implantada, os lotes daquele contrato continuam sujeitos às regras e prazos dele. Um registro de saldo no novo hook inicia seu próprio prazo de 24 horas.

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
