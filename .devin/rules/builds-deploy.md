---
trigger: model_decision
description: Orienta o agente sobre build e deploy no projeto AgenticSpace, que possui módulos independentes (backend, frontend, frontend_dashboard, smartcontracts) sem package.json na raiz. Deve ser carregado ao planejar, executar ou corrigir rotinas de build, install, CI/CD ou deploy.
---

# Build e Deploy — AgenticSpace

## Contexto

O projeto `AgenticSpace` é um monorepo com módulos independentes, sem `package.json` na raiz. Cada camada possui seu próprio gerenciador de dependências e scripts de build:

- `backend/` — Node.js/Express (`npm install`, `npm test`, `npm start`)
- `frontend/` — Next.js (`npm run build`, `npm run build:static`)
- `frontend_dashboard/` — Next.js (`npm run build`, `npm run build:static`)
- `smartcontracts/` — Hardhat/Foundry (`npm run compile`, `npm run test`, `npm run deploy:*`)

O agente deve respeitar a autonomia de cada módulo e evitar assumir a existência de um workspace único do npm.

## Build

1. **Sempre inicie pela instalação das dependências do módulo alterado:**
   - `npm install` dentro da pasta do módulo
   - use `npm ci` em pipelines/CI para reprodutibilidade

2. **Scripts padrão esperados em cada módulo:**
   - `build:install` — instala dependências e executa build (ex.: `npm install && npm run build`)
   - `build` — compila o módulo
   - `test` — roda testes unitários/integração

3. **Next.js (`frontend/` e `frontend_dashboard/`):**
   - Use `npm run build:static` para gerar saída estática e copiar automaticamente para `backend/` via `copy-to-backend`.
   - Valide que os scripts `create-redirects` e `copy-to-backend` existem e funcionam antes de executar.

4. **Backend (`backend/`):**
   - `npm start` inicia o servidor em `src/agent-server.js`.
   - `npm test` roda `node --test src/*.test.js`.
   - O backend consome os artefatos estáticos gerados pelos frontends.

5. **Smart Contracts (`smartcontracts/`):**
   - `npm run compile` — Hardhat
   - `npm run test` — Hardhat
   - `npm run test:foundry` — Foundry
   - `npm run audit:full` — lint + Slither + Mythril + Echidna
   - Nunca rode deploy em mainnet sem revisão humana e checklist de segurança.

6. **Validações antes do build:**
   - Presença de `.env` e `.env.local` quando exigidos pelo módulo.
   - Variáveis críticas como `DATABASE_URL`, `NEO4J_URI`, `RPC_*`, `PRIVATE_KEY` (apenas via `.env`).
   - Versão do Node (`>=18.x`) conforme `engines` dos `package.json`.

7. **Orquestração global:**
   - Se o usuário pedir build completo, proponha criar um script `scripts/build-all.sh` (ou similar) em vez de exigir `package.json` na raiz.
   - Execute builds na ordem: `smartcontracts` → `backend` → `frontend` → `frontend_dashboard`.
   - Registre logs resumidos por módulo (sucesso/falha) e aborte em caso de erro.

## Deploy

1. **Deploy de frontends estáticos:**
   - `frontend/` e `frontend_dashboard/` devem ser compilados com `build:static`.
   - Os artefatos são copiados para `backend/` para servir as páginas.
   - Se houver deploy no Vercel, use o diretório correspondente e respeite `next.config.*`.

2. **Deploy do backend:**
   - Após build e testes, commite as alterações incluindo artefatos de frontend copiados.
   - Push para o remote de produção configurado.
   - Nunca exponha `.env` no repositório; confirme que `.gitignore` os protege.

3. **Deploy de smart contracts:**
   - Use scripts `deploy:*:amoy` para testes em testnet.
   - Use scripts `deploy:*:polygon` apenas para mainnet após revisão.
   - Sempre verifique e valide endereços, proxies e timelocks após o deploy.

4. **Checklist de deploy:**
   - [ ] Testes passam (`npm test` no módulo alterado)
   - [ ] Build gera sem erros
   - [ ] `.env` atualizado e não versionado
   - [ ] Smart contracts auditados (se alterados)
   - [ ] Git commit e push realizados no repositório correto
   - [ ] Logs de deploy revisados

## Segurança

- Nunca escreva chaves privadas, mnemônicos, tokens ou senhas em arquivos de código, configuração ou logs.
- Mantenha segredos em `.env` e certifique-se de que `.gitignore` o inclui.
- Em caso de dúvida, peça confirmação humana antes de executar deploy em mainnet ou produção.