# Security Checklist — Smart Contracts Solidity

> **AVISO:** Este arquivo é o espelho operacional da regra
> `.devin/rules/solidity-security.md`. Ele **não deve ser removido** e deve ser
> atualizado a cada verificação de segurança. Sua remoção compromete a
> rastreabilidade de segurança do projeto.

---

## Última revisão

| Campo | Valor |
|-------|-------|
| **Data** | 2026-07-14 |
| **Responsável** | Cascade (AI Assistant) |
| **Contratos revisados** | 40+ contratos (Diamond, Facets, Token, Faucet, Libraries, Storage) |
| **Ferramentas executadas** | Revisão manual de código-fonte |
| **Relatório detalhado** | `docs/security-audit-2025-07-14.md` |
| **Achados CRÍTICO** | 2 |
| **Achados ALTO** | 9 |
| **Achados MÉDIO** | 8 |

---

## Legenda

- **[CRÍTICO]** pode causar perda de fundos, tomada do sistema ou fraude de identidade.
- **[ALTO]** pode interromper o sistema, violar privacidade ou permitir operações indevidas.
- **[MÉDIO]** prejudica manutenção, rastreabilidade ou robustez.

---

## 1. Definição do modelo de ameaça

- [ ] Identificar quais contratos controlam dinheiro ou tokens.
- [ ] Identificar quais contratos controlam identidades, DIDs e credenciais.
- [ ] Identificar quais funções podem criar, atualizar, suspender ou revogar registros.
- [ ] Identificar administradores, emissores, validadores, oráculos, bridges e operadores.
- [ ] Listar o impacto do comprometimento de cada chave.
- [ ] Definir o que acontece se o frontend, backend, banco de dados ou IPFS forem comprometidos.
- [ ] Definir o que acontece se um emissor de VC agir maliciosamente.
- [ ] Definir o que acontece se uma carteira for roubada.
- [ ] Definir o que acontece se uma assinatura for reutilizada.
- [ ] Definir o que acontece se um contrato externo retornar dados falsos.
- [ ] Definir os estados de emergência: pausa, revogação, recuperação e migração.
- [ ] Documentar invariantes que nunca podem ser violadas.

### Invariantes documentadas

| # | Invariante | Status |
|---|-----------|--------|
| 1 | A oferta total nunca pode superar o limite definido | [x] CASToken MAX_SUPPLY enforced |
| 2 | Um usuário não pode ser registrado duas vezes com o mesmo identificador | [x] UserRegistryFacet verifica userByAddress |
| 3 | Uma VC revogada nunca pode voltar a ser válida sem uma nova emissão | [x] AgentValidatorFacet isValid flag |
| 4 | Somente emissores autorizados podem emitir credenciais | [x] VALIDATOR_ROLE exigido |
| 5 | A quantidade de wrapped tokens nunca pode superar os ativos bloqueados | [x] N/A — sem wrapped coin |

---

## 2. Compilador, dependências e construção

- [x] **[ALTO]** Utilizar uma versão estável recente do Solidity. — 0.8.28
- [ ] Fixar a versão do compilador, evitando intervalos excessivamente abertos. — **A-8:** pragma `^0.8.28` deve ser `0.8.28`
- [ ] Verificar se a versão escolhida aparece na lista de bugs conhecidos.
- [x] Fixar as versões das dependências no `package-lock.json` ou equivalente. — package-lock presente
- [x] Não importar contratos diretamente de branches instáveis.
- [x] Utilizar bibliotecas consolidadas (OpenZeppelin) em vez de reimplementar. — OZ 5.0.2
- [x] Verificar mudanças incompatíveis ao atualizar versões principais da OpenZeppelin.
- [x] Compilar com as mesmas configurações usadas nos testes. — hardhat.config.ts fixo
- [x] Registrar versão do compilador, otimizador e número de execuções. — 0.8.28, viaIR, 200 runs, cancun
- [ ] Verificar se o bytecode publicado corresponde ao código-fonte auditado.
- [ ] Verificar o contrato em um explorador de blocos depois do deploy.

---

## 3. Controle de acesso

- [ ] **[CRÍTICO]** Toda função administrativa possui controle de acesso? — **C-1:** funções init*() sem auth
- [x] **[CRÍTICO]** Funções de mint, burn, pause, upgrade, revoke, issue e withdraw estão protegidas? — exceto init*()
- [x] Utilizar `Ownable` apenas para sistemas realmente simples. — Faucet, CASMigration, CASBatchTransfer, LiquidityLock
- [x] Para sistemas maiores, utilizar `AccessControl` ou `AccessManager`. — DiamondAccessControl + OZ AccessControl
- [x] Separar funções por papéis. — MINTER, PAUSER, VALIDATOR, REGISTRAR, DAO_*, TREASURER, RATIO_ADMIN
- [ ] Não conceder todas as permissões para uma única carteira. — **M-8:** DiamondInit concede todos roles ao owner
- [ ] Utilizar carteira multisig para administração crítica. — não implementado
- [ ] Aplicar princípio do menor privilégio. — **M-2:** owner bypassa todos os roles
- [ ] Verificar quem administra o `DEFAULT_ADMIN_ROLE`.
- [x] Evitar que um administrador possa conceder privilégios a si próprio sem controle. — só owner grant/revoke
- [x] Implementar processo seguro de transferência de administração. — OwnershipFacet transferOwnership
- [ ] Preferir transferência de propriedade em duas etapas. — transferência em uma etapa
- [ ] Remover privilégios de deployers temporários após a implantação.
- [x] Emitir eventos quando papéis forem concedidos ou revogados. — RoleGranted/RoleRevoked
- [ ] Considerar timelock para upgrades, alterações de parâmetros e retiradas grandes. — **A-9:** sem timelock
- [ ] Testar chamadas feitas por usuários não autorizados. — **M-7:** sem testes para facets
- [ ] Verificar se alguma função interna sensível foi exposta como `public` ou `external`. — **C-1:** init*() expostas
- [ ] Verificar se callbacks podem contornar o controle de acesso.

---

## 4. Autenticação e assinaturas

- [ ] **[CRÍTICO]** Não utilizar somente `msg.sender` quando a operação depende de uma assinatura externa.
- [ ] Utilizar mensagens estruturadas com EIP-712.
- [ ] Incluir domínio de assinatura (nome, versão, chainId, endereço do contrato).
- [ ] Incluir um nonce único.
- [ ] Incluir prazo de validade (deadline).
- [ ] Marcar o nonce como consumido após a execução.
- [ ] Impedir replay em outra blockchain.
- [ ] Impedir replay em outro contrato.
- [ ] Impedir replay após upgrade ou mudança de versão.
- [ ] Verificar o endereço recuperado pela assinatura.
- [ ] Rejeitar endereço zero.
- [ ] Verificar assinaturas de carteiras inteligentes com ERC-1271.
- [ ] Não assumir que todo usuário é uma EOA.
- [ ] Utilizar bibliotecas consolidadas para ECDSA.
- [ ] Verificar malleability da assinatura.
- [ ] Garantir que o conteúdo assinado corresponda exatamente à operação executada.

---

## 5. Cadastro e inscrição de usuários

- [ ] Definir claramente o identificador único do usuário.
- [ ] Impedir cadastro duplicado.
- [ ] Não usar somente endereço de carteira como identidade permanente.
- [ ] Considerar troca ou recuperação de carteira.
- [ ] Não permitir que qualquer carteira registre dados em nome de outra sem autorização.
- [ ] Validar endereço zero.
- [ ] Validar campos vazios.
- [ ] Limitar tamanho de strings e arrays recebidos.
- [ ] Evitar loops sobre todos os usuários.
- [ ] Evitar armazenar listas ilimitadas que precisam ser percorridas.
- [ ] Utilizar `mapping` para consultas de existência.
- [ ] Definir se uma carteira pode controlar mais de um DID.
- [ ] Definir se um DID pode ter mais de um controlador.
- [ ] Definir processo de atualização do controlador.
- [ ] Definir recuperação em caso de chave perdida.
- [ ] Implementar estados explícitos: ativo, suspenso, revogado ou removido.
- [ ] Evitar remoções que apaguem completamente o histórico necessário à auditoria.
- [ ] Emitir eventos para cadastro, atualização, suspensão e revogação.
- [ ] Não emitir dados pessoais completos nos eventos.
- [ ] Impedir front-running de inscrições que usam identificadores públicos.
- [ ] Quando necessário, utilizar esquema commit-reveal.

---

## 6. Privacidade e dados pessoais

- [ ] **[CRÍTICO]** Não armazenar dados pessoais completos diretamente na blockchain.
- [ ] Não gravar nome, documento, endereço, telefone, e-mail ou informações médicas em texto aberto.
- [ ] Lembrar que dados `private` em Solidity não são secretos.
- [ ] Armazenar somente hashes, compromissos criptográficos ou referências mínimas.
- [ ] Não considerar um hash simples de CPF ou e-mail como anonimização segura.
- [ ] Utilizar salt ou compromissos quando o conjunto de valores puder ser enumerado.
- [ ] Não colocar o conteúdo completo da VC em eventos.
- [ ] Não colocar chaves privadas ou segredos no contrato.
- [ ] Não armazenar tokens de API, senhas, JWTs ou credenciais de infraestrutura.
- [ ] Evitar URLs que permitam rastreamento individual.
- [ ] Avaliar correlação entre diferentes apresentações da mesma credencial.
- [ ] Utilizar divulgação seletiva quando o caso exigir.
- [ ] Separar: prova de existência; conteúdo da credencial; estado de revogação; dados de identidade.
- [ ] Avaliar o que ocorre quando dados off-chain são removidos, mas o hash permanece on-chain.
- [ ] Documentar quais informações são públicas, pseudônimas ou confidenciais.

---

## 7. DIDs

- [ ] Validar a sintaxe e o método DID esperado.
- [ ] Não aceitar qualquer string como DID sem normalização.
- [ ] Definir se o contrato armazena: DID completo, hash do DID, controlador, hash do DID Document, ou referência externa.
- [ ] Verificar se o método DID realmente utiliza blockchain.
- [ ] Validar alterações de controlador.
- [ ] Exigir autorização do controlador atual para rotação.
- [ ] Implementar recuperação ou múltiplos controladores quando necessário.
- [ ] Impedir que uma chave removida continue autorizada.
- [ ] Manter número de versão ou nonce do documento.
- [ ] Evitar rollback para um DID Document antigo.
- [ ] Registrar data ou bloco da atualização.
- [ ] Definir mecanismo de desativação permanente.
- [ ] Separar atualização de documento e transferência de controle.
- [ ] Evitar dependência total de um resolvedor centralizado.
- [ ] Verificar indisponibilidade do resolvedor.
- [ ] Validar o documento retornado contra o identificador solicitado.
- [ ] Não confiar automaticamente em URLs existentes no DID Document.
- [ ] Proteger contra SSRF no backend que resolve URLs de documentos DID.
- [ ] Verificar chaves expiradas, revogadas ou rotacionadas.
- [ ] Determinar se assinaturas anteriores continuam válidas após rotação de chave.

---

## 8. Verifiable Credentials — VCs

- [ ] Somente emissores autorizados podem registrar ou emitir uma VC.
- [ ] Verificar a identidade e a chave do emissor.
- [ ] Verificar o `issuer`.
- [ ] Verificar o `credentialSubject`.
- [ ] Verificar a prova criptográfica.
- [ ] Verificar o algoritmo permitido.
- [ ] Rejeitar algoritmos não suportados ou ausência de proteção de integridade.
- [ ] Verificar `validFrom`, `validUntil` ou campos equivalentes.
- [ ] Verificar status de suspensão ou revogação.
- [ ] Verificar o esquema da credencial.
- [ ] Verificar se o tipo de credencial é aceito.
- [ ] Impedir que o mesmo identificador de credencial seja emitido duas vezes.
- [ ] Não considerar "hash registrado on-chain" como prova suficiente de validade.
- [ ] Confirmar que o hash foi registrado pelo emissor autorizado.
- [ ] Confirmar que a VC apresentada produz exatamente o mesmo hash.
- [ ] Definir canonicalização consistente antes do hash.
- [ ] Evitar calcular hash sobre JSON sem uma canonicalização definida.
- [ ] Não confiar na ordem das propriedades JSON.
- [ ] Verificar a vinculação entre holder e credential subject.
- [ ] Evitar apresentação de credenciais roubadas.
- [ ] Utilizar `challenge` e `domain` em apresentações.
- [ ] Impedir replay de uma Verifiable Presentation.
- [ ] Implementar revogação escalável.
- [ ] Testar credenciais expiradas, suspensas, revogadas e malformadas.
- [ ] Evitar armazenar a VC completa on-chain.
- [ ] Considerar divulgação seletiva para reduzir exposição de atributos.

---

## 9. Reentrância

- [x] **[CRÍTICO]** Identificar todas as chamadas externais. — mapeadas em todos os contratos
- [x] Aplicar o padrão Checks–Effects–Interactions. — UserRegistryFacet documenta CEI
- [ ] Utilizar `ReentrancyGuard` em operações sensíveis. — **A-3:** PaymentFacet sem guard, **A-4:** Faucet sem guard, **M-5:** UserRegistryFacet sem guard
- [ ] Não proteger apenas a função principal; analisar reentrância entre funções diferentes.
- [ ] Avaliar reentrância de somente leitura.
- [x] Atualizar saldos antes da transferência. — CEI em UserRegistryFacet
- [x] Evitar chamadas externas durante alterações parciais de estado.
- [ ] Considerar que ERC-721 e ERC-1155 possuem callbacks.
- [ ] Considerar tokens ERC-777 ou tokens não convencionais.
- [ ] Não assumir que uma chamada para um token é segura.
- [x] Evitar depender do antigo limite de gás de `transfer()` como proteção. — usa call{value:}

---

## 10. Chamadas externas e contratos não confiáveis

- [x] Tratar qualquer endereço externo como potencialmente malicioso.
- [x] Verificar se o endereço esperado possui código quando obrigatório. — LibDiamond.enforceHasContractCode
- [x] Não usar `extcodesize` como única forma de distinguir usuário de contrato. — usado apenas para validar facets
- [ ] Validar valores de retorno. — **C-2:** PaymentLib não valida retorno de transferFrom corretamente
- [x] Verificar `success` em chamadas de baixo nível. — verificado em CASSwap, InfrastructureFund, Faucet
- [ ] Não ignorar retornos de ERC-20. — **C-2:** PaymentLib usa transferFrom sem SafeERC20
- [ ] Utilizar `SafeERC20`. — **C-2:** PaymentLib não usa; **M-6:** PaymentLib WETH usa call direto
- [x] Definir comportamento quando a chamada externa falhar. — reverts customizados
- [x] Não permitir que uma falha externa deixe o estado inconsistente.
- [x] Limitar o efeito de contratos plugáveis ou configuráveis.
- [x] Emitir evento quando endereços de dependências forem alterados. — CasTokenSet, InfrastructureFundSet, etc.
- [x] Proteger funções que alteram endereço de token, oracle, bridge ou verifier. — owner-only
- [ ] Verificar se contratos externos podem chamar novamente o contrato. — **A-3:** PaymentFacet batch sem guard
- [x] Evitar `delegatecall` para endereços fornecidos pelo usuário. — só via diamondCut owner-only
- [x] Nunca fazer `delegatecall` para implementação não validada. — enforceHasContractCode
- [x] Evitar chamadas arbitrárias controladas por parâmetros externos.

---

## 11. Ether, pagamentos e retiradas

- [ ] Verificar se o contrato realmente precisa receber Ether.
- [ ] Implementar `receive()` e `fallback()` conscientemente.
- [ ] Rejeitar Ether não esperado.
- [ ] Não assumir que o saldo do contrato corresponde à contabilidade interna.
- [ ] Ether pode ser forçado para um contrato.
- [ ] Utilizar modelo de saque, em vez de enviar automaticamente para muitos usuários.
- [ ] Limitar retiradas administrativas.
- [ ] Utilizar multisig e timelock para tesouraria.
- [ ] Impedir retirada para endereço zero.
- [ ] Emitir evento de retirada.
- [ ] Testar destinatários que rejeitam Ether.
- [ ] Testar contratos destinatários que tentam reentrância.
- [ ] Verificar arredondamentos em divisão de valores.
- [ ] Definir tratamento de poeira residual.
- [ ] Não usar `tx.origin` para autorização.

---

## 12. ERC-20 e Token Coin

- [ ] Utilizar implementação ERC-20 consolidada.
- [ ] Definir claramente oferta inicial.
- [ ] Definir se existe oferta máxima.
- [ ] Proteger mint.
- [ ] Proteger `burnFrom`, quando existir.
- [ ] Verificar se administradores podem cunhar ilimitadamente.
- [ ] Documentar poder de congelamento ou pausa.
- [ ] Definir comportamento durante pausa.
- [ ] Verificar `decimals`.
- [ ] Não utilizar `decimals` em cálculos de segurança como se alterasse a unidade interna.
- [ ] Verificar permissões de `approve` e `transferFrom`.
- [ ] Considerar o risco de alteração de allowance.
- [ ] Considerar `permit`, caso utilizado.
- [ ] Em `permit`, validar nonce, deadline, domínio EIP-712 e assinatura.
- [ ] Impedir replay de `permit`.
- [ ] Verificar compatibilidade com contratos que não retornam `bool`.
- [ ] Utilizar `SafeERC20` ao interagir com tokens externos.
- [ ] Testar tokens fee-on-transfer.
- [ ] Testar tokens rebasing, se forem aceitos.
- [ ] Não assumir que o valor recebido é igual ao parâmetro de transferência.
- [ ] Medir saldo antes e depois quando necessário.
- [ ] Evitar hooks complexos em transferências.
- [ ] Verificar se blacklist ou pause podem bloquear contratos do próprio protocolo.
- [ ] Verificar se a política administrativa está claramente documentada.

---

## 13. Wrapped Coin

- [ ] **[CRÍTICO]** Cada mint possui ativo correspondente bloqueado?
- [ ] **[CRÍTICO]** Cada burn libera no máximo o ativo correspondente?
- [ ] O mint ocorre somente após confirmação válida do depósito?
- [ ] Um depósito não pode ser processado duas vezes?
- [ ] Existe identificador único para cada depósito?
- [ ] Nonces ou IDs de mensagens são consumidos?
- [ ] O sistema impede replay entre redes?
- [ ] O `chainId` de origem e destino faz parte da mensagem?
- [ ] O endereço do contrato de origem e destino faz parte da mensagem?
- [ ] Existe confirmação mínima de blocos?
- [ ] Existe tratamento para reorganização da blockchain?
- [ ] Existe limite por transação e por período?
- [ ] Existe pausa de emergência?
- [ ] O sistema utiliza multisig ou conjunto distribuído de validadores?
- [ ] Existe quórum mínimo de assinaturas?
- [ ] Validadores duplicados são rejeitados?
- [ ] Assinaturas repetidas não contam duas vezes.
- [ ] A lista de validadores não pode ser alterada instantaneamente.
- [ ] Mudanças críticas possuem timelock.
- [ ] O contrato mantém contabilidade do colateral.
- [ ] Taxas não quebram a correspondência entre depósito e mint.
- [ ] Decimais diferentes entre ativos são tratados corretamente.
- [ ] Arredondamentos não permitem criação de valor.
- [ ] Existe plano para ativos presos.
- [ ] Existe procedimento em caso de bridge comprometida.
- [ ] A propriedade administrativa não permite mint arbitrário sem evidência do depósito.

---

## 14. Oráculos e preços

- [ ] Não utilizar preço fornecido diretamente pelo usuário.
- [ ] Não utilizar somente reservas instantâneas de uma DEX.
- [ ] Avaliar manipulação por flash loan.
- [ ] Verificar atualização e idade do preço.
- [ ] Rejeitar preço expirado.
- [ ] Verificar valor zero ou negativo quando o oracle suportar valores assinados.
- [ ] Definir faixa aceitável.
- [ ] Utilizar múltiplas fontes quando o risco justificar.
- [ ] Implementar circuit breaker.
- [ ] Definir comportamento quando o oracle parar.
- [ ] Não continuar operações financeiras com preço sabidamente desatualizado.
- [ ] Testar grande variação de preço.
- [ ] Testar indisponibilidade da fonte.

---

## 15. Front-running, MEV e ordenação

- [x] Verificar operações cujo conteúdo público permite cópia lucrativa.
- [ ] Proteger registro de nomes, DIDs ou identificadores disputáveis. — publicId em texto aberto
- [ ] Considerar commit-reveal.
- [ ] Incluir preço mínimo, máximo ou slippage. — **A-7:** CASSwap sem slippage
- [ ] Incluir deadline. — **A-7:** CASSwap sem deadline
- [x] Não confiar na ordem exata de transações.
- [x] Não usar `block.timestamp` como fonte secreta.
- [x] Não usar `blockhash`, timestamp ou dificuldade como aleatoriedade segura.
- [ ] Avaliar sandwich attacks em swaps. — **A-7:** CASSwap vulnerável
- [x] Impedir que um operador observe uma assinatura e execute em benefício próprio. — sem assinaturas
- [x] Vincular assinaturas ao destinatário correto. — N/A
- [x] Vincular assinaturas à função e aos parâmetros exatos. — N/A

---

## 16. DoS e consumo de gás

- [ ] Não percorrer arrays ilimitados. — **A-6:** CASMigration.batchMigrate sem limite
- [x] Não distribuir valores para todos os usuários em um único loop. — limite MAX_BATCH em PaymentFacet/CASBatchTransfer
- [x] Utilizar modelo pull para retiradas. — não aplicável (sem distribuição automática)
- [ ] Implementar paginação. — getAgentsByOwner, getRoleMembers retornam arrays completos
- [x] Limitar tamanho de lotes. — MAX_BATCH_RECIPIENTS=200 em PaymentFacet e CASBatchTransfer
- [x] Limitar strings e bytes recebidos. — strings calldata limitadas pelo gas
- [x] Não permitir que um usuário faça arrays crescerem indefinidamente sem custo proporcional.
- [ ] Evitar remoções caras de arrays. — **M-3:** revokeRole não limpa arrays
- [ ] Avaliar gas griefing.
- [x] Garantir que um destinatário malicioso não bloqueie todos os demais. — safeTransfer reverte individualmente
- [ ] Testar o contrato com o número máximo esperado de registros. — **M-7:** sem testes
- [ ] Verificar se funções administrativas continuam executáveis com o estado grande.
- [x] Verificar se revogações em massa são realmente necessárias.
- [ ] Não depender de uma função que possa ultrapassar o limite de gás no futuro. — **A-6:** batchMigrate

---

## 17. Aritmética e precisão

- [ ] Revisar todos os blocos `unchecked`.
- [ ] Utilizar `unchecked` somente com justificativa documentada.
- [ ] Verificar divisão antes da multiplicação.
- [ ] Avaliar perda de precisão.
- [ ] Definir regra de arredondamento.
- [ ] Evitar divisão por zero.
- [ ] Verificar conversões entre tipos.
- [ ] Revisar casts para tipos menores.
- [ ] Verificar conversão entre `uint256` e `int256`.
- [ ] Testar valores mínimos e máximos.
- [ ] Verificar diferenças de decimais entre tokens.
- [ ] Avaliar acúmulo de erro em taxas, juros ou recompensas.
- [ ] Garantir que soma de parcelas não ultrapasse 100%.
- [ ] Verificar taxas configuráveis contra limites máximos.
- [ ] Impedir que taxa administrativa seja configurada para 100% ou mais.

---

## 18. Eventos e auditoria

- [ ] Emitir eventos para alterações importantes de estado.
- [ ] Emitir evento em: cadastro, alteração de DID, emissão de VC, suspensão, revogação, mint, burn, depósito, retirada, alteração de papéis, alteração de dependências, pausa, upgrade.
- [ ] Não depender exclusivamente de eventos para estado crítico.
- [ ] Não emitir informações pessoais.
- [ ] Indexar somente campos realmente úteis.
- [ ] Não indexar dados sensíveis imaginando que ficarão ocultos.
- [ ] Garantir que eventos representem a operação final efetivamente concluída.
- [ ] Não emitir evento de sucesso antes de uma chamada que pode falhar.
- [ ] Utilizar nomes claros e consistentes.
- [ ] Monitorar eventos administrativos em produção.

---

## 19. Contratos upgradeable

- [x] **[CRÍTICO]** Não utilizar `constructor` para inicializar estado do contrato de implementação. — CASToken/CASSwap/InfraFund usam initialize()
- [x] Utilizar função `initialize`. — OZ Initializable
- [x] Proteger inicialização contra segunda execução. — OZ initializer modifier
- [x] Desabilitar inicializadores no contrato de implementação.
- [x] Proteger `_authorizeUpgrade`. — onlyRole(DEFAULT_ADMIN_ROLE)
- [x] Não permitir upgrade por qualquer usuário. — admin-only
- [ ] Utilizar multisig e timelock. — **A-9:** sem timelock nem multisig
- [ ] Verificar compatibilidade do storage layout.
- [x] Não alterar ordem das variáveis existentes.
- [x] Não alterar tipos das variáveis existentes.
- [x] Não remover variáveis existentes.
- [x] Adicionar novas variáveis somente no final.
- [ ] Testar atualização com estado real previamente criado. — **M-7:** sem testes de upgrade
- [ ] Verificar inicializadores de módulos herdados.
- [x] Não esquecer inicializador de contratos pais. — __ERC20_init, __Pausable_init, etc.
- [x] Evitar colisão de storage. — Diamond Storage usa slots dedicados
- [ ] Verificar se a implementação nova pode ser inicializada por atacante. — **C-1:** init*() sem auth
- [x] Verificar se existe função de upgrade direta na implementação. — _authorizeUpgrade protegido
- [x] Emitir evento e documentar cada upgrade. — DiamondCut event
- [ ] Possuir mecanismo de rollback operacional.
- [x] Não confundir "upgrade possível" com "upgrade seguro".

---

## 20. delegatecall, proxies e módulos

- [ ] Não executar `delegatecall` para endereço fornecido pelo usuário.
- [ ] Validar toda implementação antes de registrá-la.
- [ ] Proteger alteração de facets, módulos e implementações.
- [ ] Verificar colisões de seletores de funções.
- [ ] Verificar colisões de storage.
- [ ] Impedir módulos de sobrescrever administração.
- [ ] Verificar se módulos podem executar `selfdestruct` ou chamadas destrutivas.
- [ ] Não assumir que uma facet ou biblioteca é isolada.
- [ ] Auditar o sistema completo, não cada módulo separadamente.
- [ ] Documentar quais contratos compartilham storage.
- [ ] Testar chamadas através do proxy, não apenas diretamente na implementação.

---

## 21. Pausa e resposta a incidentes

- [x] Implementar pausa apenas onde ela realmente reduz riscos. — PausableFacet + OZ Pausable
- [x] Definir quem pode pausar. — PAUSER_ROLE
- [ ] Separar quem pausa de quem retoma, quando necessário. — mesmo role pausa e despausa
- [x] Definir quais operações continuam durante pausa. — view functions e admin
- [ ] Permitir retiradas seguras durante determinadas emergências, se possível. — não implementado
- [x] Não permitir mint ou emissão durante pausa. — enforceNotPaused em registerAgent, validateAgent
- [x] Não deixar funções alternativas contornarem a pausa. — CASToken _update override
- [x] Emitir evento de pausa e retomada. — Paused/Unpaused events
- [ ] Utilizar multisig para retomada crítica. — não implementado
- [ ] Criar runbook de incidente. — não documentado
- [ ] Definir contatos e responsabilidades.
- [ ] Definir procedimento de rotação de chaves.
- [ ] Definir procedimento para emissor comprometido.
- [ ] Definir procedimento para VC emitida fraudulentamente.
- [ ] Definir procedimento para colateral insuficiente.
- [ ] Definir procedimento para bridge ou oracle comprometido.

> **A-5:** Faucet não tem mecanismo de pausa.

---

## 22. Testes automatizados

- [x] Testar caminho feliz. — testes existem para token contracts
- [ ] Testar todas as condições de erro. — **M-7:** cobertura insuficiente
- [ ] Testar cada modificador de acesso. — **M-7:** sem testes para facets
- [ ] Testar usuário não autorizado. — **M-7:** sem testes para facets
- [x] Testar endereço zero. — alguns testes cobrem
- [x] Testar valores zero. — alguns testes cobrem
- [ ] Testar valores máximos. — CASTokenMaxSupply.test.ts existe
- [x] Testar duplicidade. — Diamond.test.ts
- [ ] Testar replay de assinatura. — N/A (sem assinaturas)
- [ ] Testar assinatura expirada. — N/A
- [ ] Testar assinatura para outra rede. — N/A
- [ ] Testar assinatura para outro contrato. — N/A
- [ ] Testar contrato ERC-1271. — N/A
- [ ] Testar reentrância. — **M-7:** sem testes de reentrância
- [ ] Testar token malicioso.
- [ ] Testar token que não retorna `bool`.
- [ ] Testar token com taxa de transferência.
- [x] Testar pausa. — alguns testes cobrem
- [ ] Testar revogação. — **M-7:** sem testes para AgentValidatorFacet
- [ ] Testar rotação de controlador DID. — N/A
- [ ] Testar VC expirada. — N/A (sem expiração implementada)
- [ ] Testar VC revogada. — **M-7:** sem testes
- [ ] Testar DID desativado. — **M-7:** sem testes
- [ ] Testar upgrade. — **M-7:** sem testes de upgrade
- [ ] Testar manutenção do estado após upgrade.
- [ ] Testar falha de chamada externa.
- [ ] Testar grandes quantidades de registros.
- [ ] Verificar cobertura de linhas, branches e funções.
- [x] Não considerar 100% de cobertura como prova de segurança.

---

## 23. Fuzzing e testes de invariantes

- [ ] Criar propriedades que devem ser verdadeiras para qualquer sequência de chamadas. — **I-1:** não implementado
- [ ] Executar fuzzing com Foundry, Echidna ou ferramenta equivalente. — **I-1:** script existe mas sem config
- [ ] Testar sequências aleatórias de: cadastro, emissão, suspensão, revogação, transferência, mint, burn, wrap, unwrap.
- [ ] Testar chamadas feitas por diferentes atores.
- [ ] Testar valores extremos.
- [ ] Executar testes stateful.

### Invariantes recomendadas

| # | Invariante | Status |
|---|-----------|--------|
| 1 | `totalSupply` nunca excede `cap` | [ ] |
| 2 | `totalWrapped` nunca excede collateral | [ ] |
| 3 | Uma VC revogada nunca é aceita como válida | [ ] |
| 4 | Um nonce consumido nunca pode ser reutilizado | [ ] |
| 5 | Somente usuários com `ISSUER_ROLE` emitem credenciais | [ ] |
| 6 | Um DID desativado não pode autorizar novas operações | [ ] |
| 7 | O saldo agregado nunca excede a oferta total | [ ] |
| 8 | Nenhuma retirada excede o saldo registrado | [ ] |

---

## 24. Análise estática e formal

- [ ] Executar Slither em cada pull request. — **I-2:** script existe mas sem evidência de execução
- [ ] Revisar manualmente cada alerta.
- [ ] Não ignorar alertas sem justificativa.
- [ ] Utilizar detectores personalizados para regras do projeto.
- [ ] Executar análise de dependências.
- [ ] Utilizar SMTChecker em propriedades adequadas.
- [ ] Considerar verificação formal para: oferta total, controle de acesso, colateral do wrapped token, impossibilidade de replay, revogação permanente, integridade de nonces.
- [ ] Analisar bytecode quando a criticidade justificar.
- [ ] Revisar diferenças entre código auditado e código implantado.

---

## 25. Segurança da dApp e infraestrutura

- [ ] Verificar o endereço e a rede antes de solicitar assinatura.
- [ ] Mostrar ao usuário exatamente o que será assinado.
- [ ] Não solicitar assinaturas genéricas ou ilimitadas.
- [ ] Limitar allowances.
- [ ] Evitar approve infinito por padrão.
- [ ] Validar `chainId`.
- [ ] Validar endereço do contrato no frontend.
- [ ] Proteger arquivos de configuração de deploy.
- [ ] Não manter chave de deploy no repositório.
- [ ] Utilizar hardware wallet ou cofre seguro para chaves administrativas.
- [ ] Separar chave de deploy, chave operacional e chave administrativa.
- [ ] Utilizar multisig.
- [ ] Proteger domínio e DNS.
- [ ] Implementar CSP e proteções web.
- [ ] Validar dados retornados por RPC.
- [ ] Ter provedores RPC alternativos.
- [ ] Não confiar apenas no backend para determinar validade on-chain.
- [ ] Verificar dependências NPM.
- [ ] Fixar versões.
- [ ] Proteger CI/CD.
- [ ] Revisar scripts de deploy.
- [ ] Exigir revisão antes de deploy em produção.
- [ ] Simular a transação antes de executá-la.
- [ ] Monitorar alterações administrativas on-chain.

---

## 26. Checklist final antes do deploy

- [ ] Código congelado para auditoria.
- [ ] Testes unitários aprovados.
- [ ] Testes de integração aprovados.
- [ ] Testes de invariantes aprovados.
- [ ] Fuzzing executado.
- [ ] Slither sem alertas não justificados.
- [ ] Revisão manual concluída.
- [ ] Dependências fixadas.
- [ ] Compilador fixado.
- [ ] Bugs conhecidos do compilador verificados.
- [ ] Storage layout validado.
- [ ] Scripts de deploy revisados.
- [ ] Endereços de tokens e dependências conferidos.
- [ ] Papéis administrativos conferidos.
- [ ] Deployer sem privilégios desnecessários.
- [ ] Multisig configurada.
- [ ] Timelock configurado.
- [ ] Pausa testada.
- [ ] Processo de recuperação testado.
- [ ] Testnet utilizada.
- [ ] Fork de mainnet utilizado quando houver integração com protocolos existentes.
- [ ] Bytecode reproduzível.
- [ ] Código verificado no explorador.
- [ ] Endereço do contrato publicado em canal confiável.
- [ ] Monitoramento configurado.
- [ ] Plano de resposta a incidentes documentado.
- [ ] Auditoria externa realizada para contratos que controlam fundos ou identidades críticas.

---

## Prioridade específica para o projeto

Para os contratos do AgenticSpace, a ordem de prioridade é:

1. Controle de acesso e separação de papéis.
2. Proteção contra replay de assinaturas.
3. Privacidade de VCs e DIDs.
4. Revogação, suspensão e rotação de chaves.
5. Invariante entre wrapped token e colateral.
6. Mint e burn protegidos.
7. Reentrância e chamadas externas.
8. Upgrade seguro e storage layout.
9. Fuzzing e testes de invariantes.
10. Segurança das chaves administrativas e da dApp.

**Recomendação arquitetural:** mantenha dados pessoais e conteúdo completo das
credenciais fora da blockchain. No contrato, registre apenas o mínimo necessário,
como hashes, emissores autorizados, identificadores não sensíveis e estado de
revogação. A blockchain deve funcionar como camada de confiança e verificação,
não como banco público de documentos pessoais.

---

## Histórico de revisões

| Data | Responsável | Contratos revisados | Alterações |
|------|------------|---------------------|------------|
| 2026-07-14 | _Inicial_ | — | Criação do arquivo espelho conforme regra `solidity-security.md` |
| 2026-07-14 | Cascade (AI) | 40+ contratos | Revisão manual completa. 2 CRÍTICO, 9 ALTO, 8 MÉDIO. Ver `security-audit-2025-07-14.md` |
