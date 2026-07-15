# CASMigration

## Visão Geral

O `CASMigration` é um contrato que permite a conversão de CAS v1 (antigo, sem MAX_SUPPLY) para CAS v2 (novo, com MAX_SUPPLY de 10 milhões) na ratio 1:1.

Usuários que já possuem CAS v1 podem migrar seus tokens para CAS v2 de forma simples e segura, sem perda de valor.

## Contrato

- **Arquivo**: `contracts/token/CASMigration.sol`
- **Padrão**: Ownable (OpenZeppelin)
- **Bibliotecas**: SafeERC20

## Como Funciona

1. O deployer (owner) deploya o CASMigration com os endereços do CAS v1 e CAS v2.
2. O deployer minta CAS v2 para o contrato de migração (reserva).
3. Usuários aprovam o CAS v1 para o contrato de migração (`approve`).
4. Usuários chamam `migrate(amount)` para trocar CAS v1 por CAS v2.
5. O CAS v1 é enviado para `0xdead` (queimado/lockado).
6. O CAS v2 é transferido para o usuário.

## Funções

### Públicas

| Função | Descrição |
|--------|-----------|
| `migrate(uint256 amount)` | Migra CAS v1 → v2. Requer `approve` prévio no CAS v1. |
| `availableNewCAS()` | Retorna saldo de CAS v2 disponível para migração. |

### Owner

| Função | Descrição |
|--------|-----------|
| `batchMigrate(address[] users, uint256[] amounts)` | Migra em lote para múltiplos usuários. |
| `setMigrationActive(bool active)` | Ativa/desativa a migração. |
| `rescueTokens(address token, address to, uint256 amount)` | Resgata tokens não migrados (após migração encerrada). |

### View

| Função | Descrição |
|--------|-----------|
| `oldCAS()` | Endereço do CAS v1. |
| `newCAS()` | Endereço do CAS v2. |
| `totalMigrated()` | Total migrado até o momento. |
| `migrationActive()` | Se a migração está ativa. |

## Eventos

| Evento | Descrição |
|--------|-----------|
| `Migrated(address user, uint256 amount)` | Emitido a cada migração bem-sucedida. |
| `MigrationActivated()` | Emitido quando a migração é ativada. |
| `MigrationDeactivated()` | Emitido quando a migração é desativada. |
| `TokensRescued(address token, address to, uint256 amount)` | Emitido quando tokens são resgatados. |

## Erros

| Erro | Condição |
|------|----------|
| `MigrationNotActive()` | Migração chamada quando inativa. |
| `ZeroAmount()` | Amount = 0. |
| `ZeroAddress()` | Endereço zero no construtor ou rescue. |

## Deploy

### Pré-requisitos

- CAS v1 deployado (endereço em `OLD_CAS_ADDRESS`)
- CAS v2 deployado (endereço em `CAS_TOKEN_ADDRESS`)
- Deployer com `MINTER_ROLE` no CAS v2

### Script

```bash
npx hardhat run scripts/deploy/07_deploy_cas_migration.ts --network polygonAmoy
```

### Variáveis de Ambiente

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `OLD_CAS_ADDRESS` | Endereço do CAS v1 | — |
| `CAS_TOKEN_ADDRESS` | Endereço do CAS v2 | — |
| `MIGRATION_RESERVE` | Quantidade de CAS v2 para reserva | totalSupply do v1 |

### Pós-Deploy

1. Setar `CAS_MIGRATION_ADDRESS` no `.env`
2. Anunciar aos usuários o endereço do contrato de migração
3. Usuários devem:
   - `oldCAS.approve(migrationAddress, amount)`
   - `migration.migrate(amount)`

## Segurança

- O CAS v1 é enviado para `0xdead` (efetivamente queimado)
- A migração é 1:1 sem taxa
- O owner pode pausar a migração a qualquer momento
- O owner pode resgatar CAS v2 não migrado após encerrar
- `batchMigrate` permite migração assistida para usuários que não conseguem interagir diretamente

## Testes

```bash
npx hardhat test test/token/CASMigration.test.ts
```

Cobertura: 18 testes — inicialização, migrate, batchMigrate, setMigrationActive, rescueTokens, availableNewCAS.

## Changelog

| Data | Versão | Mudança |
|------|--------|---------|
| 2025-07-12 | 1.0.0 | Criação do CASMigration para migração v1 → v2 |
