---
trigger: always_on
---

# Node.js via NVM — smartcontracts/

Este módulo (Hardhat + Foundry) **não deve depender do Node do sistema**
(`/usr/bin/node`, tipicamente desatualizado — ex.: v18.x). Sempre use o Node
gerenciado pelo NVM, resolvido via path absoluto, para garantir reprodutibilidade
entre sessões de shell (cada chamada de `exec` sem `shell_id` abre um shell novo
e não herda `nvm use` de comandos anteriores).

## 1. Localização do NVM

- `NVM_DIR` padrão: `$HOME/.nvm` (script: `$NVM_DIR/nvm.sh`).
- Antes de qualquer comando `node`/`npm`/`npx`/`hardhat`/`forge` neste módulo,
  carregue o NVM e ative a versão do `.nvmrc`:

  ```bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm use
  ```

- Em comandos `exec` avulsos (sem `shell_id` persistente), encadeie tudo em uma
  única chamada, pois o `cd`/`nvm use` não persiste entre invocações
  one-shot:

  ```bash
  export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && cd smartcontracts && nvm use && npm run compile
  ```

- Alternativa determinística (evita depender de PATH/alias): resolva o binário
  absoluto da versão ativa e invoque-o diretamente, útil em scripts ou hooks:

  ```bash
  NODE_BIN="$(NVM_DIR="$HOME/.nvm" bash -lc '. "$NVM_DIR/nvm.sh" && nvm which $(cat .nvmrc)')"
  "$NODE_BIN" -v
  ```

## 2. `.nvmrc`

- `smartcontracts/.nvmrc` deve conter a versão mínima exigida pelo toolchain
  (Hardhat `^2.22.0` + `@nomicfoundation/hardhat-toolbox` `^5.0.0` requerem
  Node 18 LTS ou superior; padronizamos em **Node 22 LTS**, alinhado ao
  `.nvmrc` da raiz do monorepo em `AgenticSpace/.nvmrc`).
- **Padronize o formato**: use apenas o número da versão maior, sem prefixo
  `v` (ex.: `22`), igual ao `.nvmrc` da raiz — hoje há divergência
  (`smartcontracts/.nvmrc` = `v22`, raiz = `22`). Ambos os formatos são aceitos
  pelo `nvm use`, mas a consistência evita confusão entre módulos.
- No início de qualquer tarefa neste módulo:
  1. Leia `smartcontracts/.nvmrc` e confirme a versão mínima exigida.
  2. Rode `nvm ls` para confirmar que a versão (ou uma compatível igual/maior
     dentro da mesma major) está instalada localmente.
  3. Se não estiver instalada, rode `nvm install` (instala a versão do
     `.nvmrc` do diretório corrente) antes de prosseguir — nunca caia para o
     Node do sistema como fallback silencioso.
  4. Se o `package.json` não tiver o campo `"engines"`, sugira adicioná-lo
     (`"engines": { "node": ">=22.0.0" }`) para que `npm install`/CI também
     validem a versão.

## 3. Verificação

- Após ativar a versão, confirme com `node -v` e `npm -v` antes de rodar
  `npm install`, `npm run compile`, `npm run test`, `npm run test:foundry` ou
  qualquer script de `deploy:*`.
- Nunca assuma que o `node` do `PATH` já é o correto — nesta máquina o
  `/usr/bin/node` é uma versão distinta (não gerenciada pelo NVM) e pode
  quebrar builds do Hardhat de forma silenciosa (erros de compilação de
  addons nativos, incompatibilidade de `ethers`/`hardhat-toolbox`, etc.).