---
trigger: model_decision
description: Aplicado ao criar, modificar ou auditar smart contracts em Solidity. Define regras obrigatórias de segurança, auditoria independente, governança multisig/timelock, ferramentas de auditoria, práticas defensivas e manutenção de checklist espelho no subprojeto.
---

# Solidity Security Rule

## Arquivo Espelho de Checklist (Obrigatório)

Sempre que uma verificação de segurança for realizada em contratos Solidity,
um arquivo espelho de checklist **deve** ser criado e mantido em
`<subprojeto>/docs/security-checklist.md` — onde `<subprojeto>` é o diretório
raiz do subprojeto que contém os contratos (ex: `smartcontracts/docs/`).

### Regras do arquivo espelho

- O arquivo deve refletir fielmente o checklist completo definido na seção
  **Checklist de Segurança** abaixo.
- O arquivo deve ser atualizado **a cada verificação de segurança** realizada.
- Itens verificados devem ser marcados com `[x]`; itens pendentes com `[ ]`.
- Cada item deve incluir a data da última verificação e o responsável.
- O arquivo **não deve ser removido** — sua remoção compromete a rastreabilidade
  de segurança.
- Alterações no checklist desta regra exigem atualização imediata do arquivo
  espelho em todos os subprojetos com contratos Solidity.
- O arquivo espelho é a fonte de verdade operacional para auditorias e revisões.

### Estrutura do arquivo espelho

O arquivo deve conter:

1. Cabeçalho com data da última revisão e responsável.
2. Seção de modelo de ameaça preenchida.
3. Checklist completo com 26 seções (conforme abaixo).
4. Seção de invariantes documentadas.
5. Seção de prioridades específicas do projeto.
6. Histórico de revisões (data, responsável, alterações).

---

## Princípios Obrigatórios

### 1. Padrões Defensivos

- **Checks-Effects-Interactions:** Sempre atualizar estado antes de chamadas externas.
- **ReentrancyGuard:** Usar `ReentrancyGuardUpgradeable` em todos os contratos que fazem chamadas externas.
- **Access Control:** Todo contrato deve ter controle de acesso via modifiers. Usar `AccessControlUpgradeable` da OpenZeppelin.
- **Input Validation:** Validar todos os parâmetros com `require` ou custom errors. Nunca confiar em input externo.
- **Integer Overflow:** Solidity 0.8+ tem overflow checking nativo. Usar `unchecked` apenas quando provado seguro.

### 2. Proibições

- **PROIBIDO:** `tx.origin` para autenticação (use `msg.sender`).
- **PROIBIDO:** Assembly não auditado sem revisão explícita.
- **PROIBIDO:** `delegatecall` para contratos não whitelistados.
- **PROIBIDO:** `selfdestruct` sem autorização multi-sig.
- **PROIBIDO:** Hardcode de chaves privadas ou segredos no código.
- **PROIBIDO:** `block.timestamp` para lógica crítica de tempo (pode ser manipulado por miners/validators).
- **PROIBIDO:** Dependência de `block.number` para prazos precisos.
- **PROIBIDO:** Armazenar dados pessoais completos (nome, documento, e-mail, telefone) na blockchain.
- **PROIBIDO:** Usar somente `msg.sender` quando a operação depende de assinatura externa — usar EIP-712.
- **PROIBIDO:** Importar contratos de branches instáveis.
- **PROIBIDO:** Reimplementar ERC-20, controle de acesso ou verificação de assinaturas manualmente — usar OpenZeppelin.

### 3. Obrigações

- **Eventos:** Toda mutação de estado deve emitir um evento.
- **Modifiers:** Access control via modifiers nomeados e documentados.
- **Custom Errors:** Usar custom errors ao invés de strings em `require` para economizar gas.
- **NatSpec:** Documentar funções external/public com `@dev`, `@param`, `@return`.
- **Licença:** SPDX-License-Identifier no topo de cada arquivo.
- **Pragma:** Versão fixa (ex: `pragma solidity 0.8.36;`) — evitar intervalos abertos como `>=0.8.20`.
- **Dependências:** Fixar versões no `package-lock.json` ou equivalente.
- **Compilador:** Registrar versão do compilador, otimizador e número de execuções.
- **Bytecode:** Verificar se o bytecode publicado corresponde ao código-fonte auditado.

### 4. Auditoria Obrigatória

Antes de qualquer merge para main ou deploy em mainnet:

1. **Solhint:** `npm run audit:solhint` — zero erros.
2. **Slither:** `npm run audit:slither` — zero high/medium sem justificativa documentada.
3. **Mythril:** `npm run audit:mythril` — zero issues críticas.
4. **Echidna:** `npm run audit:echidna` — zero falhas de invariante.
5. **Cobertura:** Mínimo 90% em contratos core.
6. **Fuzzing:** Executar fuzzing com Foundry ou Echidna em propriedades e invariantes.
7. **Verificação formal:** Considerar SMTChecker para propriedades críticas.
8. **Revisão manual:** Cada alerta deve ser revisado — não ignorar sem justificativa documentada.

#### Auditoria Independente e Governança Multisig/Timelock

Antes de publicar ou atualizar contratos em mainnet:

- **Auditoria independente:** Todo contrato core deve ser auditado por firma ou especialista externo independente; o relatório deve ser armazenado em `<subprojeto>/docs/audit-report.md` e registrado no checklist espelho.
- **Governança multisig:** Ações críticas (upgrades, alterações de parâmetros, retiradas da tesouraria, concessão/revogação de papéis administrativos e configuração de oráculos/bridges) devem exigir aprovação de múltiplas assinaturas com quórum documentado.
- **Timelock:** Mudanças sensíveis devem passar por um período de espera on-chain (timelock) de no mínimo 48h, salvo justificativa documentada e aprovada pela governança.
- **Transparência:** Endereços do multisig e timelock devem ser documentados e verificáveis publicamente; mudanças na composição devem emitir eventos e passar pelo mesmo processo.
- **Revisão pós-auditoria:** Correções recomendadas pela auditoria independente devem ser implementadas e revalidadas antes do deploy.

### 5. Upgradeabilidade Segura

- Nunca usar `constructor` para inicializar estado do contrato de implementação — usar `initialize`.
- Proteger inicialização contra segunda execução.
- Desabilitar inicializadores no contrato de implementação.
- Proteger `_authorizeUpgrade`.
- Nunca remover variáveis de estado existentes.
- Nunca alterar ordem ou tipo de variáveis de estado existentes.
- Adicionar novas variáveis no final do contrato.
- Usar `__gap` em contratos herdados para reservar espaço.
- Testar upgrade em fork da mainnet antes de executar.
- Testar manutenção do estado após upgrade.
- Usar `OpenZeppelin Defender` ou script `upgrade_contract.ts` para upgrades.
- Usar multisig e timelock para upgrades.
- Emitir evento e documentar cada upgrade.
- Possuir mecanismo de rollback operacional.

### 6. Access Control por Papel

- `DEFAULT_ADMIN_ROLE`: gestão de roles (multi-sig recomendado).
- `AGENT_ROLE`: agentes registrados no `AgentRegistry`.
- `VALIDATOR_ROLE`: validadores autorizados.
- `DAO_PROPOSER_ROLE`: quem pode criar propostas nas DAOs.
- `DAO_VOTER_ROLE`: quem pode votar nas DAOs.
- `ISSUER_ROLE`: emissores autorizados de credenciais.
- `REVOKER_ROLE`: revogadores autorizados.
- `PAUSER_ROLE`: responsáveis por pausa de emergência.
- `UPGRADER_ROLE`: responsáveis por upgrades.
- `MINTER_ROLE`: responsáveis por mint.
- Princípio do menor privilégio: cada role tem apenas as permissões necessárias.
- Não conceder todas as permissões para uma única carteira.
- Evitar que um administrador conceda privilégios a si próprio sem controle.
- Preferir transferência de propriedade em duas etapas.
- Remover privilégios de deployers temporários após implantação.
- Testar chamadas feitas por usuários não autorizados.

### 7. Eventos de Segurança

Todos os eventos de segurança devem ser logados on-chain:

- `AgentRegistered(agentId, did, ownerAddress)`
- `AgentValidated(agentId, promptHash, validationId)`
- `ProposalCreated(proposalId, proposer, proposalType)`
- `VoteCast(proposalId, voter, support)`
- `RoleGranted(role, account, sender)`
- `RoleRevoked(role, account, sender)`
- `ContractUpgraded(name, oldVersion, newVersion, newAddress)`

Não emitir dados pessoais completos nos eventos. Indexar somente campos úteis
e não sensíveis.

### 8. Limites e Guardas

- Tamanho máximo de contrato: 24KB (EIP-170).
- Limite de gas por transação: configurável e monitorado.
- Rate limiting on-chain para funções críticas (ex: `require(block.number >= lastBlock + cooldown)`).
- Pausa de emergência: contratos core devem implementar `PausableUpgradeable`.
- Separar quem pausa de quem retoma, quando necessário.
- Não permitir mint ou emissão durante pausa.
- Criar runbook de incidente com contatos e responsabilidades.

### 9. Autenticação e Assinaturas

- Usar EIP-712 para mensagens estruturadas com domínio (nome, versão, chainId, endereço do contrato).
- Incluir nonce único e deadline em todas as assinaturas.
- Marcar nonce como consumido após execução.
- Impedir replay entre blockchains e entre contratos.
- Verificar endereço recuperado; rejeitar endereço zero.
- Verificar assinaturas de carteiras inteligentes com ERC-1271.
- Usar bibliotecas consolidadas para ECDSA (OpenZeppelin).
- Verificar malleability da assinatura.
- Garantir que o conteúdo assinado corresponda exatamente à operação executada.

### 10. Privacidade e Dados Pessoais

- Armazenar somente hashes, compromissos criptográficos ou referências mínimas on-chain.
- Dados `private` em Solidity não são secretos.
- Utilizar salt ou compromissos quando o conjunto de valores puder ser enumerado.
- Não colocar chaves privadas, tokens de API, senhas ou credenciais no contrato.
- Separar prova de existência, conteúdo da credencial, estado de revogação e dados de identidade.
- Documentar quais informações são públicas, pseudônimas ou confidenciais.

---

## Checklist de Segurança para Smart Contracts em Solidity

### Legenda

- **[CRÍTICO]** pode causar perda de fundos, tomada do sistema ou fraude de identidade.
- **[ALTO]** pode interromper o sistema, violar privacidade ou permitir operações indevidas.
- **[MÉDIO]** prejudica manutenção, rastreabilidade ou robustez.

### 1. Definição do modelo de ameaça

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

**Exemplos de invariantes:**
- A oferta total nunca pode superar o limite definido.
- Um usuário não pode ser registrado duas vezes com o mesmo identificador.
- Uma VC revogada nunca pode voltar a ser válida sem uma nova emissão.
- Somente emissores autorizados podem emitir credenciais.
- A quantidade de wrapped tokens nunca pode superar os ativos bloqueados.

### 2. Compilador, dependências e construção

- [ ] **[ALTO]** Utilizar uma versão estável recente do Solidity.
- [ ] Fixar a versão do compilador, evitando intervalos excessivamente abertos.
- [ ] Verificar se a versão escolhida aparece na lista de bugs conhecidos.
- [ ] Fixar as versões das dependências no `package-lock.json` ou equivalente.
- [ ] Não importar contratos diretamente de branches instáveis.
- [ ] Utilizar bibliotecas consolidadas (OpenZeppelin) em vez de reimplementar.
- [ ] Verificar mudanças incompatíveis ao atualizar versões principais da OpenZeppelin.
- [ ] Compilar com as mesmas configurações usadas nos testes.
- [ ] Registrar versão do compilador, otimizador e número de execuções.
- [ ] Verificar se o bytecode publicado corresponde ao código-fonte auditado.
- [ ] Verificar o contrato em um explorador de blocos depois do deploy.

### 3. Controle de acesso

- [ ] **[CRÍTICO]** Toda função administrativa possui controle de acesso?
- [ ] **[CRÍTICO]** Funções de mint, burn, pause, upgrade, revoke, issue e withdraw estão protegidas?
- [ ] Utilizar `Ownable` apenas para sistemas realmente simples.
- [ ] Para sistemas maiores, utilizar `AccessControl` ou `AccessManager`.
- [ ] Separar funções por papéis.
- [ ] Não conceder todas as permissões para uma única carteira.
- [ ] Utilizar carteira multisig para administração crítica.
- [ ] Aplicar princípio do menor privilégio.
- [ ] Verificar quem administra o `DEFAULT_ADMIN_ROLE`.
- [ ] Evitar que um administrador possa conceder privilégios a si próprio sem controle.
- [ ] Implementar processo seguro de transferência de administração.
- [ ] Preferir transferência de propriedade em duas etapas.
- [ ] Remover privilégios de deployers temporários após a implantação.
- [ ] Emitir eventos quando papéis forem concedidos ou revogados.
- [ ] Considerar timelock para upgrades, alterações de parâmetros e retiradas grandes.
- [ ] Testar chamadas feitas por usuários não autorizados.
- [ ] Verificar se alguma função interna sensível foi exposta como `public` ou `external`.
- [ ] Verificar se callbacks podem contornar o controle de acesso.

### 4. Autenticação e assinaturas

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

### 5. Cadastro e inscrição de usuários

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

### 6. Privacidade e dados pessoais

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

### 7. DIDs

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

### 8. Verifiable Credentials — VCs

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

### 9. Reentrância

- [ ] **[CRÍTICO]** Identificar todas as chamadas externas.
- [ ] Aplicar o padrão Checks–Effects–Interactions.
- [ ] Utilizar `ReentrancyGuard` em operações sensíveis.
- [ ] Não proteger apenas a função principal; analisar reentrância entre funções diferentes.
- [ ] Avaliar reentrância de somente leitura.
- [ ] Atualizar saldos antes da transferência.
- [ ] Evitar chamadas externas durante alterações parciais de estado.
- [ ] Considerar que ERC-721 e ERC-1155 possuem callbacks.
- [ ] Considerar tokens ERC-777 ou tokens não convencionais.
- [ ] Não assumir que uma chamada para um token é segura.
- [ ] Evitar depender do antigo limite de gás de `transfer()` como proteção.

### 10. Chamadas externas e contratos não confiáveis

- [ ] Tratar qualquer endereço externo como potencialmente malicioso.
- [ ] Verificar se o endereço esperado possui código quando obrigatório.
- [ ] Não usar `extcodesize` como única forma de distinguir usuário de contrato.
- [ ] Validar valores de retorno.
- [ ] Verificar `success` em chamadas de baixo nível.
- [ ] Não ignorar retornos de ERC-20.
- [ ] Utilizar `SafeERC20`.
- [ ] Definir comportamento quando a chamada externa falhar.
- [ ] Não permitir que uma falha externa deixe o estado inconsistente.
- [ ] Limitar o efeito de contratos plugáveis ou configuráveis.
- [ ] Emitir evento quando endereços de dependências forem alterados.
- [ ] Proteger funções que alteram endereço de token, oracle, bridge ou verifier.
- [ ] Verificar se contratos externos podem chamar novamente o contrato.
- [ ] Evitar `delegatecall` para endereços fornecidos pelo usuário.
- [ ] Nunca fazer `delegatecall` para implementação não validada.
- [ ] Evitar chamadas arbitrárias controladas por parâmetros externos.

### 11. Ether, pagamentos e retiradas

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

### 12. ERC-20 e Token Coin

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

### 13. Wrapped Coin

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

### 14. Oráculos e preços

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

### 15. Front-running, MEV e ordenação

- [ ] Verificar operações cujo conteúdo público permite cópia lucrativa.
- [ ] Proteger registro de nomes, DIDs ou identificadores disputáveis.
- [ ] Considerar commit-reveal.
- [ ] Incluir preço mínimo, máximo ou slippage.
- [ ] Incluir deadline.
- [ ] Não confiar na ordem exata de transações.
- [ ] Não usar `block.timestamp` como fonte secreta.
- [ ] Não usar `blockhash`, timestamp ou dificuldade como aleatoriedade segura.
- [ ] Avaliar sandwich attacks em swaps.
- [ ] Impedir que um operador observe uma assinatura e execute em benefício próprio.
- [ ] Vincular assinaturas ao destinatário correto.
- [ ] Vincular assinaturas à função e aos parâmetros exatos.

### 16. DoS e consumo de gás

- [ ] Não percorrer arrays ilimitados.
- [ ] Não distribuir valores para todos os usuários em um único loop.
- [ ] Utilizar modelo pull para retiradas.
- [ ] Implementar paginação.
- [ ] Limitar tamanho de lotes.
- [ ] Limitar strings e bytes recebidos.
- [ ] Não permitir que um usuário faça arrays crescerem indefinidamente sem custo proporcional.
- [ ] Evitar remoções caras de arrays.
- [ ] Avaliar gas griefing.
- [ ] Garantir que um destinatário malicioso não bloqueie todos os demais.
- [ ] Testar o contrato com o número máximo esperado de registros.
- [ ] Verificar se funções administrativas continuam executáveis com o estado grande.
- [ ] Verificar se revogações em massa são realmente necessárias.
- [ ] Não depender de uma função que possa ultrapassar o limite de gás no futuro.

### 17. Aritmética e precisão

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

### 18. Eventos e auditoria

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

### 19. Contratos upgradeable

- [ ] **[CRÍTICO]** Não utilizar `constructor` para inicializar estado do contrato de implementação.
- [ ] Utilizar função `initialize`.
- [ ] Proteger inicialização contra segunda execução.
- [ ] Desabilitar inicializadores no contrato de implementação.
- [ ] Proteger `_authorizeUpgrade`.
- [ ] Não permitir upgrade por qualquer usuário.
- [ ] Utilizar multisig e timelock.
- [ ] Verificar compatibilidade do storage layout.
- [ ] Não alterar ordem das variáveis existentes.
- [ ] Não alterar tipos das variáveis existentes.
- [ ] Não remover variáveis existentes.
- [ ] Adicionar novas variáveis somente no final.
- [ ] Testar atualização com estado real previamente criado.
- [ ] Verificar inicializadores de módulos herdados.
- [ ] Não esquecer inicializador de contratos pais.
- [ ] Evitar colisão de storage.
- [ ] Verificar se a implementação nova pode ser inicializada por atacante.
- [ ] Verificar se existe função de upgrade direta na implementação.
- [ ] Emitir evento e documentar cada upgrade.
- [ ] Possuir mecanismo de rollback operacional.
- [ ] Não confundir "upgrade possível" com "upgrade seguro".

### 20. delegatecall, proxies e módulos

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

### 21. Pausa e resposta a incidentes

- [ ] Implementar pausa apenas onde ela realmente reduz riscos.
- [ ] Definir quem pode pausar.
- [ ] Separar quem pausa de quem retoma, quando necessário.
- [ ] Definir quais operações continuam durante pausa.
- [ ] Permitir retiradas seguras durante determinadas emergências, se possível.
- [ ] Não permitir mint ou emissão durante pausa.
- [ ] Não deixar funções alternativas contornarem a pausa.
- [ ] Emitir evento de pausa e retomada.
- [ ] Utilizar multisig para retomada crítica.
- [ ] Criar runbook de incidente.
- [ ] Definir contatos e responsabilidades.
- [ ] Definir procedimento de rotação de chaves.
- [ ] Definir procedimento para emissor comprometido.
- [ ] Definir procedimento para VC emitida fraudulentamente.
- [ ] Definir procedimento para colateral insuficiente.
- [ ] Definir procedimento para bridge ou oracle comprometido.

### 22. Testes automatizados

- [ ] Testar caminho feliz.
- [ ] Testar todas as condições de erro.
- [ ] Testar cada modificador de acesso.
- [ ] Testar usuário não autorizado.
- [ ] Testar endereço zero.
- [ ] Testar valores zero.
- [ ] Testar valores máximos.
- [ ] Testar duplicidade.
- [ ] Testar replay de assinatura.
- [ ] Testar assinatura expirada.
- [ ] Testar assinatura para outra rede.
- [ ] Testar assinatura para outro contrato.
- [ ] Testar contrato ERC-1271.
- [ ] Testar reentrância.
- [ ] Testar token malicioso.
- [ ] Testar token que não retorna `bool`.
- [ ] Testar token com taxa de transferência.
- [ ] Testar pausa.
- [ ] Testar revogação.
- [ ] Testar rotação de controlador DID.
- [ ] Testar VC expirada.
- [ ] Testar VC revogada.
- [ ] Testar DID desativado.
- [ ] Testar upgrade.
- [ ] Testar manutenção do estado após upgrade.
- [ ] Testar falha de chamada externa.
- [ ] Testar grandes quantidades de registros.
- [ ] Verificar cobertura de linhas, branches e funções.
- [ ] Não considerar 100% de cobertura como prova de segurança.

### 23. Fuzzing e testes de invariantes

- [ ] Criar propriedades que devem ser verdadeiras para qualquer sequência de chamadas.
- [ ] Executar fuzzing com Foundry, Echidna ou ferramenta equivalente.
- [ ] Testar sequências aleatórias de: cadastro, emissão, suspensão, revogação, transferência, mint, burn, wrap, unwrap.
- [ ] Testar chamadas feitas por diferentes atores.
- [ ] Testar valores extremos.
- [ ] Executar testes stateful.

**Invariantes recomendadas:**
- `totalSupply` nunca excede `cap`.
- `totalWrapped` nunca excede collateral.
- Uma VC revogada nunca é aceita como válida.
- Um nonce consumido nunca pode ser reutilizado.
- Somente usuários com `ISSUER_ROLE` emitem credenciais.
- Um DID desativado não pode autorizar novas operações.
- O saldo agregado nunca excede a oferta total.
- Nenhuma retirada excede o saldo registrado.

### 24. Análise estática e formal

- [ ] Executar Slither em cada pull request.
- [ ] Revisar manualmente cada alerta.
- [ ] Não ignorar alertas sem justificativa.
- [ ] Utilizar detectores personalizados para regras do projeto.
- [ ] Executar análise de dependências.
- [ ] Utilizar SMTChecker em propriedades adequadas.
- [ ] Considerar verificação formal para: oferta total, controle de acesso, colateral do wrapped token, impossibilidade de replay, revogação permanente, integridade de nonces.
- [ ] Analisar bytecode quando a criticidade justificar.
- [ ] Revisar diferenças entre código auditado e código implantado.

> Segurança de dApp, infraestrutura de deploy e checklist final antes do deploy: ver `deploy.md`

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
