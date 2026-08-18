---
description: Aplicado ao fazer deploy, upgrade ou operações on-chain de smart contracts em Solidity. Define papéis, ambientes, gestão de chaves, scripts, verificação e checklist final.
trigger: model_decision
---

# Smart Contracts Deploy Rule

> Regras de desenvolvimento e padrões: ver `smartcontracts.md`
> Regras de segurança e auditoria: ver `solidity-security.md`
> Regras de governança DAO: ver `dao-contracts.md`

## Papéis de Deploy

Por questões de segurança, existem dois papéis principais:

- **Owner:** conta que faz o deploy para o ambiente de produção (mainnet). Possui privilégios administrativos (upgrade, pausa, roles). Deve ser multisig.
- **Relayer:** conta que roda no backend e usa os contratos para efetuar transações operacionais. Registrada como responsável no backend. Não possui privilégios administrativos.

### Princípios

- Separar chave de deploy, chave operacional (relayer) e chave administrativa.
- Utilizar hardware wallet ou cofre seguro para chaves administrativas.
- Nunca manter chaves de deploy no repositório (ver `private_key.md`).
- Utilizar multisig para administração crítica.
- Remover privilégios de deployers temporários após a implantação.
- O deployer não deve ter privilégios desnecessários após o deploy.

## Padrão Diamond

- Contratos preferencialmente devem usar o padrão Diamond quando forem maiores que 4 contratos, evitando ajustar endereços no código quando um contrato mudar.
- Certificar-se sempre se o projeto já está usando Diamond para evitar redeploy desnecessário.
- Verificar colisões de seletores de funções ao adicionar novas facets.

## Ambientes

- **Testnet obrigatória:** todo contrato deve ser testado em testnet antes do mainnet.
- **Fork de mainnet:** utilizar fork de mainnet quando houver integração com protocolos existentes.
- **Mainnet:** somente após testnet, auditoria e checklist final aprovados.
- **Blockchain preferencial:** POL (Chain: 80002 para testnet, 137 para mainet).
- Ter provedores RPC alternativos configurados.

## Pré-Deploy

### Checklist de verificação

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
- [ ] Auditoria externa realizada para contratos que controlam fundos ou identidades críticas.

> Checklist detalhado de segurança (seções 1-24): ver `solidity-security.md`

## Durante o Deploy

- Sempre checar saldo antes de fazer o deploy, transações e registros.
- Simular a transação antes de executá-la.
- Verificar se o bytecode publicado corresponde ao código-fonte auditado.
- Confirmar endereços de tokens e dependências antes de interagir.
- Saídas human-readable nos scripts.
- Exceptions tratadas e expostas em log de forma adequada a LLM e a Human-readable.

## Pós-Deploy

- Verificar o contrato em um explorador de blocos.
- Código verificado no explorador (Etherscan/Polygonscan).
- Endereço do contrato publicado em canal confiável.
- Registrar contrato no `ContractRegistry` após deploy: `ContractRegistry.register(name, version, address)`.
- Versionamento de contratos via `ContractRegistry`.
- Backend e frontend consultam `ContractRegistry` para descobrir endereços — nunca hardcode.
- Monitoramento configurado.
- Monitorar alterações administrativas on-chain.
- Plano de resposta a incidentes documentado.

## Segurança de dApp e Infraestrutura de Deploy

- Proteger arquivos de configuração de deploy.
- Não manter chave de deploy no repositório.
- Utilizar hardware wallet ou cofre seguro para chaves administrativas.
- Separar chave de deploy, chave operacional e chave administrativa.
- Utilizar multisig.
- Proteger domínio e DNS.
- Implementar CSP e proteções web.
- Validar dados retornados por RPC.
- Ter provedores RPC alternativos.
- Não confiar apenas no backend para determinar validade on-chain.
- Verificar dependências NPM.
- Fixar versões.
- Proteger CI/CD.
- Revisar scripts de deploy.
- Exigir revisão antes de deploy em produção.
- Simular a transação antes de executá-la.
- Monitorar alterações administrativas on-chain.

## Scripts de Apoio

- Sempre checar saldo antes de fazer o deploy, transações e registros.
- Saidas human-readable.
- Exceptions tratadas e expostas em log de forma adequada a LLM e a Human-readable.

## Escalabilidade e Registro

- Novos contratos devem ser registrados no `ContractRegistry` após deploy.
- Backend e frontend consultam `ContractRegistry` para descobrir endereços.
- Nunca hardcode endereços de contratos no código off-chain.
- Versionamento de contratos via `ContractRegistry.register(name, version, address)`.