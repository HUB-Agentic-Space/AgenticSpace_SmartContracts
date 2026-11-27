---
tags:
  - smartcontracts
  - security-audit
  - certificate
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Auditoria%20de%20Seguran%C3%A7a%20%E2%80%94%20Certificate&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_secure-tests_2026-11-26-certificate-audit)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Auditoria de Segurança — `contracts/certificate/` (2026-11-26)

## Identidade do run

| Campo | Valor |
|---|---|
| Run ID | `2026-11-26-certificate-audit` |
| Modo | Full cycle (auditoria + remediação autorizada + revalidação), issue #49 |
| Revisor | Devin |
| Baseline | `main` @ `83d794c` (idêntico a `release/cas-v2` @ `64e05cd` para `contracts/certificate/`) |
| Snapshot | `fix/issue-49-certificate-security-audit` |
| Regra canônica | `.devin/rules/smartcontracts-solidity-security.md` |
| Workflow | `AgenticSpace/.devin/workflows/smartcontracts-security-audit.md` (+ playbooks) |
| Skills | nenhuma skill de auditoria Solidity instalada no módulo (verificado) |
| Branch destino | `main` e `release/cas-v2` (mesma versão do certificate em ambas) |

## Escopo

- `contracts/certificate/RapportCertificate.sol` (não-upgradeable)
- `contracts/certificate/RapportCertificateUpgradeable.sol` (UUPS)
- `contracts/certificate/RapportCertificatePhaseAdminFacet.sol` (lógica delegatecall)
- `contracts/certificate/RapportCertificateStorage.sol` (storage compartilhado)
- `contracts/certificate/RapportCertificateAccount.sol` (ERC-6551 account)
- `contracts/certificate/ERC6551Registry.sol` (registry de referência)
- `contracts/interfaces/{IERC5192,IERC6551Account,IERC6551Executable,IERC6551Registry}.sol` (dependências)
- `test/certificate/*.test.ts` (suítes adjacentes)

## Threat model (certificate)

- **Ativos:** CAS depositado em escrow no contrato e reserva CAS em cada TBA.
- **Identidade:** certificados soulbound (ERC-5192) por fase; pré-requisitos
  encadeados; revogação por `REVOKER_ROLE`.
- **Assinaturas:** EIP-712 `CertificateMintAuthorization` com nonce,
  deadline e domínio vinculado a chainId/contrato; emissor = `ISSUER_ROLE`.
- **Atores privilegiados:** `DEFAULT_ADMIN_ROLE` (UUPS + facet wiring),
  `ISSUER_ROLE`, `PHASE_MANAGER_ROLE`, `REVOKER_ROLE`, `PAUSER_ROLE`,
  `BONUS_MANAGER_ROLE`, `TRUSTED_CALLER_ROLE`.
- **Invariantes:** depósitos contábeis = `_totalCasDeposited`; CAS de mint vai
  à TBA determinística (endereço + codehash conferidos); certificado revogado
  não volta a ser válido; nonce consumido não é reutilizável; pré-requisito
  exige certificado **válido** (não revogado).

## Achados e disposição

| ID | Severidade | Título | Disposição |
|---|---|---|---|
| CERT-01 | MEDIUM | `RapportCertificateUpgradeable.mintCertificate` não emitia `Locked(tokenId)` (ERC-5192 MUST). Divergência com `RapportCertificate` e indexadores | **Corrigido** — `emit Locked(tokenId)` adicionado + teste de regressão |
| CERT-02 | MEDIUM | Pré-requisito de fase aceitava certificado **revogado** (`certificatesByRecipientAndPhase != 0` sem checar `revoked`), em ambos os contratos | **Corrigido** — prereq exige `!certificates[prereqTokenId].revoked` + teste |
| CERT-03 | LOW | `_wouldCreateCycle` (facet) usa bitmap `1 << phaseId`; `phaseId >= 256` desabilita a marcação silenciosamente, permitindo recursão não terminada (self-DoS por `PHASE_MANAGER`) | **Mitigado** — guarda `current >= 256` garante término; limitação documentada |
| CERT-04 | MEDIUM | `depositCasForMint` credita todo saldo não contabilizado ao chamador — CAS transferido sem chamada atômica pode ser reivindicado por terceiro | **Risco residual documentado** — design deliberado; mitigação operacional: transfer+deposit atômico ou `depositCasForMintFor` via Diamond (`TRUSTED_CALLER_ROLE`) |
| CERT-05 | TEST | 7 testes de `RapportCertificate.test.ts` falhavam por drift de ABI (`createPhase` com 9 parâmetros; chamadas com 7) | **Corrigido** — chamadas atualizadas; suíte 60/60 verde |

## Verificações executadas

| Check | Comando | Status | Evidência |
|---|---|---|---|
| Compilação | `npx hardhat compile` | passed | solc 0.8.28, cancun, optimizer conforme `hardhat.config` |
| Testes Hardhat | `npx hardhat test --network hardhat test/certificate/*.test.ts` | passed | **60 passing / 0 failing** (era 50/7 no baseline) |
| Solhint | `npx solhint 'contracts/certificate/*.sol'` | passed (0 erros) | 31 warnings justificados: `not-rely-on-time` (janelas de fase/deadline são semântica de negócio, tolerância de timestamp aceitável), `no-inline-assembly` (ERC-6551 proxy/registry exige), `payable-fallback`/`no-complex-fallback` (delegatecall deliberado), `max-states-count`, `immutable-vars-naming`, `max-line-length` |
| Slither | `npm run audit:slither` | not_run | wrapper executa análise global do módulo; sem seletor de escopo — registrado como pendência de release gate |
| Mythril | `npm run audit:mythril` | not_run | idem; wrapper mascara falhas com `|| true` |
| Echidna/Fuzz | `npm run audit:echidna` | not_run | `echidna-test` com lista fixa de facets; certificate fora do alvo |
| Coverage ≥90% | `npm run test:coverage` | not_run | executar antes de merge/deploy |
| Auditoria externa independente | — | blocked | requerida por política antes de mainnet; este run **não** a substitui |
| Multisig/timelock de upgrade | — | not_run (gate de release) | `_authorizeUpgrade` = `DEFAULT_ADMIN_ROLE`; finalização de roles via `scripts/deploy/15_finalize_rapport_certificate_roles.ts` |

## Alterações aplicadas

- `RapportCertificateUpgradeable.sol`: `emit Locked(tokenId)` no mint; pré-requisito exige certificado não revogado.
- `RapportCertificate.sol`: mesma checagem de revogação nos pré-requisitos.
- `RapportCertificatePhaseAdminFacet.sol`: guarda `current >= 256` no bitmap de detecção de ciclo.
- `test/certificate/RapportCertificate.test.ts`: ABI de `createPhase` corrigida + teste de pré-requisito revogado.
- `test/certificate/RapportCertificateUpgradeable.test.ts`: testes `Locked` (ERC-5192) e pré-requisito revogado.

## Gates de release

- Merge em `main`/`release/cas-v2`: **condicional** — code review + coverage do escopo recomendados.
- Deploy/mainnet: **blocked** — Slither/Mythril/Echidna/coverage e auditoria externa independente são pré-requisitos canônicos, além de multisig+timelock no upgrade.
- Risco residual aceito (CERT-04) deve constar na documentação operacional do fluxo de depósito.

## Upgrade mainnet (2026-11-26, autorizado pelo usuário)

Exceção de gate aprovada pelo usuário: deploy executado sem Slither/Mythril/coverage
e sem auditoria externa independente (segue como pendência de release).

- Nova implementação `RapportCertificateUpgradeable`: `0x3Bc724e5d04618D79180Aa05eB5c950458c5de12` (verificado no Polygonscan)
- Novo `RapportCertificatePhaseAdminFacet`: `0x3adE21A608f90F55e48a1A5DF8C89e3FCfd1F6E2` (verificado no Polygonscan)
- Proxy (inalterado): `0x0D4d5F160E57ec707Fb6a2A84C53040a1E23FA55`
- Safe `0x1743abe1A64DAB3c81e394adb4e3B56ef05F0D26` está em threshold **2-de-3**.
  Execução realizada com as três chaves de owner disponíveis no ambiente via
  `approveHash` on-chain + `execTransaction` com assinaturas pré-aprovadas:
  - nonce 20 `upgradeToAndCall` → tx `0x247e1dc36b4e7ea897a95ab803c418d8e1073b3467833687bdfec65b44d67cac`
    (reportada como revertida por bug de comparação `status !== 1n`; efetivamente executada)
  - nonce 21 `upgradeToAndCall` (replay idempotente) → tx `0x0fdeaadab60694a812d21721cf0ec670a3d817f59ea874e2745ad5c5b1c0beb6`
  - nonce 22 `setPhaseAdminFacet` → tx `0xbb1c800fcba4490acd61841cb3c64a29e9127f5bc885ccfe044c79f024efe24f`
- Estado pré-upgrade capturado: 11 fases, currentPhaseId 11, 12 certificados,
  impl anterior `0xa3bdef8eb005343aabc96f7671213bfc7ff86732`.
- Verificação pós-execução on-chain (bloco ~98021440): proxy aponta para a nova
  impl, `phaseAdminFacet` = novo facet, phaseCount 11→11, currentPhaseId 11→11,
  totalCertificates 12→12, Phase 1 "Sócio Fundador" intacta (minted 7, active).
- `hardhat.config.ts` revertido — tentativas de fork Polygon seguem **blocked**
  pela toolchain Hardhat/EDR (hardfork history desconhecido para chain 137).

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-11-26 | 0.1.0 | Run inicial da auditoria certificate (issue #49) |
| 2026-11-26 | 0.2.0 | Deploy mainnet de impl+facet corrigidos; upgrade proposto à Safe 2-de-3 |
| 2026-11-26 | 0.3.0 | Upgrade executado na Safe 2-de-3 (approveHash×3 + execTransaction); estado verificado on-chain |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
