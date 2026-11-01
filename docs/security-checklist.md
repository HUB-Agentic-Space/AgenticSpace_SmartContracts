![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Security%20Checklist%20%E2%80%94%20Smart%20Contracts%20Solidity&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_security-checklist)

[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Security Checklist — Smart Contracts Solidity

> **AVISO:** Este arquivo é o espelho operacional da regra
> `.devin/rules/solidity-security.md`. Ele **não deve ser removido** e deve ser
> atualizado a cada verificação de segurança. Sua remoção compromete a
> rastreabilidade de segurança do projeto.

---

## Última revisão

| Campo | Valor |
|-------|-------|
| **Data** | 2026-08-19 |
| **Responsável** | Cascade (AI Assistant) |
| **Contratos revisados** | 40+ contratos (Diamond, Facets, Token, Faucet, Libraries, Storage) + RapportCertificateUpgradeable split |
| **Ferramentas executadas** | Revisão manual + solhint (0 erros, 14 warnings) + slither (0 novos HIGH/CRITICAL) + testes Hardhat (50 passing) |
| **Relatório detalhado** | `docs/security-audit-2025-07-14.md` + seção abaixo (upgrade split) + `/tmp/slither-results.json` |
| **Achados CRÍTICO** | 2 |
| **Achados ALTO** | 9 |
| **Achados MÉDIO** | 8 |
| **Slither** | Executado em 2026-08-19. 269 contratos, 102 detectores, 468 achados globais (30 High, 33 Medium, 95 Low, 294 Info, 16 Opt). Certificados: 37 achados — todos pre-existentes ou falsos positivos. Nenhum novo HIGH/CRITICAL introduzido pelo multi-issuance. |
| **Mainnet upgrade** | Executado em 2026-08-19 via Safe 1-of-1 (0x1743...3249). Proxy 0x0D4d...3FA55 upgraded de impl 0x16aA...f31D para 0x2480...8Bc2. PhaseAdminFacet 0x52CC...5f29 configurado. Estado preservado: 9 fases, 10 certificados. Contratos verificados no Polygonscan. |

### Revisão adicional — EIP-8004 / EIP-8183 / x402 (2026-08-24)

| Campo | Valor |
|-------|-------|
| **Data** | 2026-08-24 |
| **Responsável** | Devin |
| **Contratos revisados** | 8 novos contratos: `Eip8004Storage`, `CommerceStorage`, `X402Storage`, `SignatureLib`, `IdentityRegistryFacet`, `ReputationRegistryFacet`, `ValidationRegistryFacet`, `AgentCommerceFacet`, `X402FacilitatorFacet` (EIP-8004 Trust Layer + EIP-8183 agent commerce + x402 facilitator) |
| **Ferramentas executadas** | **Apenas** revisão manual + suíte de testes Hardhat (`test/diamond/Eip8004Eip8183X402.test.ts`, 14 testes, todos passando). **Nenhuma auditoria completa (slither/mythril/echidna) foi realizada sobre este código novo.** |
| **Relatório detalhado** | `docs/eip8004-trust-layer.md`, `docs/eip8183-agent-commerce.md`, `docs/x402-facilitator.md` (seções "Segurança" / "Escrow, CEI e Segurança" de cada documento) |
| **Achados CRÍTICO** | 0 encontrados na revisão manual (não substitui análise estática/dinâmica — ver "Pendências" abaixo) |
| **Achados ALTO** | 0 encontrados na revisão manual |
| **Achados MÉDIO** | 0 encontrados na revisão manual |
| **Slither / Mythril / Echidna** | **Pendente.** Nenhuma das três ferramentas foi executada contra as 8 facets/libraries novas listadas acima. Isso é um follow-up obrigatório antes de qualquer deploy em mainnet — ver nota em "Prioridades específicas do projeto" abaixo. |

> [!warning] Escopo desta revisão
> Esta entrada cobre **apenas** o código novo de EIP-8004/EIP-8183/x402.
> Ela não substitui nem revalida a auditoria completa registrada em
> 2026-08-19 acima, cujos achados CRÍTICO/ALTO/MÉDIO para os demais
> contratos permanecem em aberto e não foram reavaliados aqui. Também
> não constitui uma auditoria externa independente — apenas revisão
> manual interna + testes automatizados.

### Revisão adicional — CASSwapUSDCPOLFacet (2026-09-17)

| Campo | Valor |
|-------|-------|
| **Data** | 2026-09-17 |
| **Responsável** | Devin |
| **Contratos revisados** | `CASSwapUSDCPOLFacet.sol`, `LibCASSwap.sol`, `ICASSwapUSDCPOL.sol`, `TraderGovernanceFacet.sol` |
| **Alterações** | Guarda de impacto máximo (`maxImpactBps`) nos setters de ratio; novo `setAllSwapRatios` mantendo setters individuais; `setSwapFeeBps`; `setMaxImpactBps`; cálculos de swap via `Math.mulDiv` (OpenZeppelin) para evitar overflow de 256 bits nas operações de compra/venda. Removidos `setSwapFeeBps` e `setMaxImpactBps` duplicados de `TraderGovernanceFacet` para evitar colisão de seletores no Diamond. |
| **Ferramentas executadas** | `npx hardhat compile` (sucesso, evm target cancun). Testes CASSwap: 29 passing em `CASSwapUSDCPOLFacet.test.ts`, `CASSwapDiamondIntegration.test.ts`, `CASSwapAsymmetric.test.ts` e `CASSwapWrapperFacet.test.ts`. Slither direcionado executado sobre os arquivos CASSwap. Mythril executado em `CASSwapUSDCPOLFacet`, `CASSwapWrapperFacet` e `TraderGovernanceFacet` sem achados. Echidna: harness de biblioteca `EchidnaCASSwapLibHarness` compilado e executado com `echidna-casswap-lib.yml`; todas as 6 invariantes passaram (`testLimit: 1000`). |
| **Auditoria estática/dinâmica** | Slither (Hardhat, include-paths CASSwap): 11 achados no escopo; nenhum HIGH/CRITICAL. Achados conhecidos/falsos positivos: `arbitrary-send-erc20` nos `transferFrom` de `LibCASSwap` (o parâmetro `from` é sempre `msg.sender` via facet); `divide-before-multiply` em `sellForPol`/`sellForUsdc` (perda de precisão mínima e aceitável para saída em POL/USDC); `timestamp` em `_accrueBudget` (uso padrão de `block.timestamp` para períodos); `low-level-calls` em `supportSwap`/`sellForPol` (transferências nativas com verificação `ok`); `naming-convention` em `RATIO_SETTER_ROLE()` (constante exposta como `pure` intencional). Mythril: 0 issues em `CASSwapUSDCPOLFacet`, `CASSwapWrapperFacet` e `TraderGovernanceFacet` (60s timeout). Echidna: binário baixado e instalado em `/tmp/echidna/echidna`, mas a execução falhou no autodetect de `crytic-compile` por `forge` não estar instalado — requer `foundry` na PATH ou um harness Echidna dedicado. |
| **Notas de segurança** | Os novos setters preservam `DiamondAccessControl.enforceRoleOrOwner`; `setSwapFeeBps` limita fee a `BPS_DENOMINATOR` (10000 bps); `setMaxImpactBps` limita a 10000 bps; a guarda de impacto evita mudanças abruptas de preço. Os cálculos usam `Math.mulDiv`; CEI e `SafeERC20` foram preservados. Em 2026-09-17, o Safe `0x1743...0D26` foi reforçado de 1-de-1 para 2-de-3 pelos nonces 9 e 10, com estado final verificado no nonce 11. O ownership do Diamond foi transferido ao timelock `0x6e14...d4B5`; o cut da facet `0x659c...3499` foi agendado pelo Safe no operation ID `0x1947...3f7a`, disponível após 2026-09-20 02:30:24 UTC. Todos os setters de configuração estão concentrados em `CASSwapUSDCPOLFacet`; `TraderGovernanceFacet` mantém `pauseSwap`/`unpauseSwap`, `setSlippageLimitBps`, orçamento e resgates. |

### Revisão adicional — CASSwap multi-ativo (2026-09-19)

| Campo | Valor |
|-------|-------|
| **Data** | 2026-09-19 |
| **Responsável** | Devin |
| **Contratos revisados** | `CASSwapUSDCPOLFacet.sol`, `LibCASSwap.sol`, `CASSwapStorage.sol`, `ICASSwapUSDCPOL.sol` |
| **Alterações** | Suporte a BRLA (token + ratios buy/sell, `setBRLAToken`, `setSwapRatioBRLA/Sell`); swap genérico `swapExact`/`quoteSwap` para 12 direções com CAS como pivot; `setAllSwapRatiosV2` atômico para 6 ratios; `getCasRate`/`getReservesMulti`/`getBRLAToken`; `redeemCAS`/`redeemForCAS` estendidos ao BRLA. Storage via append-only em `CASSwapStorage` (layout preservado). |
| **Ferramentas executadas** | `npx hardhat compile` (sucesso, viaIR). Novo `test/diamond/CASSwapMultiAsset.test.ts`: 18 testes passando (rotas diretas, cruzadas, spread composto, reverts, reservas, normalização USDC). Regressão: 33 testes CASSwap passando. **Slither** executado sobre o projeto completo via Hardhat (286 contratos): no escopo CASSwap, nenhum achado novo explorável — `arbitrary-send-erc20` ×4 em `LibCASSwap` (falso positivo conhecido: `from` é sempre `msg.sender` via facet), `uninitialized-local` ×4 em `sellRatioFor` (corrigido com inicialização explícita), `timestamp`/`low-level-calls`/`assembly`/`naming-convention` informacionais já documentados; demais achados apenas em `test-fixtures/` e `mocks/` (não deployados) e no `CASSwap.sol` standalone legado. **Mythril** executado em `CASSwapUSDCPOLFacet` e `CASSwapWrapperFacet` (viaIR + optimizer, solc 0.8.28): 0 issues. **Echidna** executado em `EchidnaCASSwapLibHarness` (estendido com BRLA e swap genérico): 8/8 invariantes passando (`buy_usdc_math`, `sell_usdc_math`, `buy_pol_math`, `sell_pol_math`, `generic_swap_math`, `brla_ratio_set`, `fee_capped`, `ratio_den_not_zero`). O harness completo `EchidnaCASSwapHarness` (Diamond) continua falhando no deploy dentro do Echidna — limitação de gas do construtor pesado (Diamond + facets + mocks), já presente no log de 2026-09-17 antes das mudanças; não é regressão. |
| **Notas de segurança** | Setters BRLA reutilizam `enforceRoleOrOwner` + `ReverseSpread` + `maxImpactBps`. `swapExact` é `nonReentrant`/`whenNotPaused`, valida deadline, `minOut`, reserva do ativo de saída e `msg.value == amountIn` para POL; rotas cruzadas compõem `buyRatio(in) × sellRatio(out)` preservando o spread em ambas as pernas. USDC tratado em unidades base com fator `1e12` exato (sem dupla escala). O upgrade multi-ativo foi preparado via `32_prepare_casswap_multiasset_cut.ts` (Safe 2-de-3 + timelock 48h) e **não** está deployed — a configuração inicial do BRLA fica em `33_configure_brla_ratios.ts`. |
| **Operacional** | Publicação de ratios unificada no `rapport-trader-cycle.service` (publisher único, ~1min); scripts escritores de ratio duplicados removidos (`04`, `07`, `19`, `22`, `set_asymmetric_ratios`, `unpause_and_set_asymmetric_ratios`, `set_ratio_and_unpause`); timer standalone `agenticspace-smartcontracts-cas-ratio-updater` **não instalado** para evitar publisher concorrente. Envelope de mercado compra-no-maior/vende-no-menor verificado on-chain em 2026-09-19 (buy 478.27 / sell 502.96 CAS por POL; USDC normalizado ~4624/4863 CAS por USDC). |
| **Upgrade multi-ativo** | Facet deployada em `0xbab9038B430db567a894676efe0f1De230b85d5B` (tx `0xfa73423e...`). Corte agendado no timelock via Safe (nonce 14, tx `0x4307e032...`): operationId `0x662e7e03...49af`, executável a partir de **2026-09-21 23:09:43 UTC**. Conflito de seletor detectado e corrigido antes do agendamento: `setAllSwapRatios` era `add` no corte anterior (executado em 2026-09-19 ~23:32 local) e foi reclassificado para `replace` no corte multi-ativo — a operação original `0x7a8ee037...` foi cancelada via Safe (nonce 13). Execução automática via `agenticspace-casswap-multiasset-execute.timer` (script `35_execute_casswap_multiasset_cut.ts`, verifica os 36 seletores e o init do BRLA `0xe6a537a4...ddfb`). Scripts: `32` (prepara), `33` (ratios BRLA), `34` (agenda), `35` (executa), `36` (reagenda/corrige). |

### Revisão adicional — swapFeeBps 300 → 50 (2026-09-23)

| Campo | Valor |
|-------|-------|
| **Data** | 2026-09-23 |
| **Responsável** | Devin |
| **Contratos revisados** | `CASSwapUSDCPOLFacet.sol` (`setSwapFeeBps`), `CASSwapStorage.sol`, scripts `set_swap_fee.ts` e `deploy/37–39` |
| **Alterações** | Taxa de swap por transação reduzida de **3% (300 bps) para 0,5% (50 bps)**. Default de `SWAP_FEE_BPS` em `scripts/set_swap_fee.ts` ajustado para `50`; criados `37_prepare_casswap_fee_timelock.ts` (payload + operationId), `38_schedule_casswap_fee.ts` (Safe 2-de-3 agenda `timelock.schedule`) e `39_execute_casswap_fee.ts` (executa e verifica `getSwapFeeBps()==50`). Frontend: fallback de exibição da fee `0 → 50` bps em `CASSwapInline.js`/`CASSwapModal.js` (o valor real continua lido on-chain via `getSwapFeeBps`/`swapFeeBps`). |
| **Ferramentas executadas** | Leitura on-chain `getSwapFeeBps()` = 300 antes do agendamento; tentativa direta `setSwapFeeBps` com relayer **revertida** (relayer sem `RATIO_SETTER_ROLE` e owner = timelock) — confirma que só a governança altera a fee. ESLint nos dois componentes: 0 erros. |
| **Notas de segurança** | A mudança passa integralmente pela governança existente: Safe `0x1743...0D26` (2-de-3) agendou `setSwapFeeBps(50)` no timelock `0x6e14...d4B5` — tx `0xd8a6b1a9...2721d` (nonce 15), operationId `0x25b62c97...a2ad`, executável a partir de **2026-09-26 00:11:35 UTC**. Executor aberto (qualquer conta executa após o delay). `setSwapFeeBps` permanece limitado a `BPS_DENOMINATOR` e protegido por `enforceRoleOrOwner` + `whenNotPaused`. Nenhum contrato foi modificado — apenas parâmetro de configuração via storage existente. |

### Revisão adicional — pauseSwap agendado (2026-09-25)

| Campo | Valor |
|-------|-------|
| **Data** | 2026-09-25 |
| **Responsável** | Devin |
| **Contratos revisados** | `TraderGovernanceFacet.sol` (`pauseSwap`/`unpauseSwap`), `CASSwapStorage.sol`, scripts `deploy/40–42` |
| **Alterações** | Pause do swap no Diamond agendado via governança: criados `40_prepare_casswap_pause.ts` (payload `deployments/casswap-pause.json`, salt único por timestamp ISO para permitir re-agendamentos futuros), `41_schedule_casswap_pause.ts` (Safe 2-de-3 agenda `timelock.schedule`) e `42_execute_casswap_pause.ts` (executa e verifica `isSwapPaused()==true`, remove o timer). Nenhum contrato modificado — uso do seletor `pauseSwap()` já registrado no facet `0x94b1AE50aF1FF776A9Eb211582bBAf9e7b29C96b`. |
| **Ferramentas executadas** | Leituras on-chain (RPC público): `owner()` do Diamond = timelock `0x6e14dA17...d4B5`; `facetAddress(0xed6b5ad5)` = facet de governança; `getMinDelay()` = 172800 s; `hasRole(PROPOSER_ROLE, Safe)` = true; EXECUTOR_ROLE aberto (`address(0)`). `npm run pause:casswap:polygon` no standalone `0x9399878C…`: já estava pausado (`isPaused()=true`, idempotente). Simulação `execTransaction.staticCall` aprovada antes do envio. |
| **Notas de segurança** | Safe `0x1743...0D26` (2-de-3) agendou `pauseSwap()` no timelock — tx `0x95b5e2c2...e0d5` (nonce 16), operationId `0xab3876cd...23cc`, executável a partir de **2026-09-27 12:34:54 UTC**. Execução automática via `agenticspace-casswap-pause-execute.timer` (OnCalendar 2026-09-27 12:40 UTC). Após executado, todos os caminhos `whenNotPaused` do swap revertem com `SwapPaused()` — incluindo `swapExact`, `buyCASWith*`, `sellCASFor*`, `redeem*`, `supportSwap` e os setters de ratio/fee; o unpause exige novo ciclo Safe → timelock 48h (`unpauseSwap`). |

### Revisão adicional — pauseSwap via PAUSER_ROLE (2026-09-25)

| Campo | Valor |
|-------|-------|
| **Data** | 2026-09-25 |
| **Responsável** | Devin |
| **Contratos revisados** | `TraderGovernanceFacet.sol` (v2), `DiamondAccessControl.sol`, `AccessControlFacet.sol`, scripts `deploy/43–46` |
| **Alterações** | `pauseSwap`/`unpauseSwap` migrados de `onlyOwner` para `enforceRoleOrOwner(PAUSER_ROLE)` — o owner (timelock) mantém acesso via fallback, e contas com `PAUSER_ROLE` passam a pausar/retomar **sem o delay de 48h**. Motivação: pause é operação defensiva de baixo risco que não deve depender do ciclo de governança completo. Facet v2 deployado em `0x605A59919d4e5Ee4b1963685eFB3fBd615aDb7B0` (tx `0x291c170d...152f`). Scripts: `43` (deploy facet), `44` (prepare batch), `45` (schedule), `46` (execute + verifica). |
| **Ferramentas executadas** | `npx hardhat compile` (sucesso); `npx hardhat test` nos 5 arquivos CASSwap: 52 testes passando, incluindo novo caso `"pauser role can pause and unpause swaps; unrelated user cannot"` (grantRole → pause/unpause via role; revert `MissingRole` para usuário sem role; owner continua autorizado). Leituras on-chain: `facetAddress(grantRole/diamondCut)` registrados; os 9 seletores do facet antigo enumerados via `facetFunctionSelectors`. |
| **Notas de segurança** | Batch agendado no timelock via Safe 2-de-3 (nonce 17, tx `0x6d424c7a...d0cc`): (1) `diamondCut` Replace dos 9 seletores de `0x94b1AE50...C96b` para `0x605A5991...B7B0`; (2) `grantRole(PAUSER_ROLE → Safe 0x1743abe1...0D26)`. operationId `0xba3ade6c...1dea`, executável a partir de **2026-09-27 13:55:14 UTC** — execução automática via `agenticspace-casswap-pausegov-execute.timer`. Após o cut, o pause agendado anteriormente (operationId `0xab3876cd...23cc`, seletor `0xed6b5ad5`) continua válido pois o seletor remapeia para o facet novo. Escopo deliberadamente cirúrgico: apenas pause/unpause ganham via rápida; fee, ratios, slippage, budget e resgates continuam onlyOwner → timelock 48h. PAUSER_ROLE concedida ao Safe (não a EOA) para preservar exigência 2-de-3 na pausa imediata. |

---

### Pré-deploy — ClaimVaultFacet / ClaimNFTFacet (2026-11-01)

Responsável: Devin. Escopo: revisão inicial de prontidão; **não é auditoria independente nem aprovação de mainnet**.

- [x] 2026-11-01 — Devin: branch `feat/issue-1-qr-claim-vouchers` selecionada; alterações locais de regras preservadas.
- [x] 2026-11-01 — Devin: consulta somente leitura confirmou Polygon mainnet (137), Diamond `0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b`, owner contratual `0x6e14dA17C2B9df7A5d829897F9c39b61D9E8d4B5` e `getMinDelay() = 172800` segundos (48h).
- [x] 2026-11-01 — Devin: testes locais `HARDHAT_FORK_URL= npm test -- --network hardhat test/diamond/ClaimVaultFacet.test.ts`, Node NVM 22.23.4: **10 passando**. Cobrem transferência e emissão atômica, replay, assinatura inválida, soulbound, reserva, expiração, ativo nativo, pausa, liberação e retirada. Não comprovam cobertura de 90%, fuzzing ou comportamento no fork real.
- [x] 2026-11-01 — Devin: revisão de `50_deploy_claim_facets.ts` e `51_configure_claim_assets.ts` identificou chamadas administrativas diretas pela carteira EOA; o fluxo precisa ser preparado para a governança do owner timelock antes de execução real.
- [ ] 2026-11-01 — Devin: evidência de implantação e validação desses facets na testnet não localizada nos registros consultados.
- [ ] 2026-11-01 — Devin: relatório independente cobrindo os facets de claim não localizado; `docs/audit-report.md` não está presente.
- [x] 2026-11-01 — Devin: usuário declarou revisão visual e autorizou o deploy em mainnet. Registrado como aprovação manual do solicitante; não constitui evidência de auditoria externa independente nem substitui aprovações on-chain do Safe/timelock.
- [x] 2026-11-01 — Devin: Solhint direcionado aos facets, biblioteca NFT e dois storages de claim: zero erros e quatro warnings (comprimento de linha, timestamp e assembly dos storages). O Solhint também informou nomes de regras desconhecidos na configuração existente; nenhum controle foi alterado.
- [x] 2026-11-01 — Devin: Slither direcionado via Hardhat, reutilizando artefatos: 436 contratos processados, 102 detectores e 10 resultados no relatório. Severidades: 1 High (`arbitrary-send-eth` em `_transferAsset`), 1 Medium (`incorrect-equality` em `received == 0`), 1 Low (`timestamp`) e 7 Informational. Relatório local: `/tmp/agenticspace-claim-slither-hardhat-20261101.json`. Saída 255; **não representa aprovação**. A primeira tentativa selecionou Foundry por autodetecção e falhou sem `out/build-info`; reexecutada com `--compile-force-framework hardhat`. Houve avisos de configuração desconhecida e falhas de geração IR em métodos do certificado legado; limitações registradas, sem supressão de detectores.
- [x] 2026-11-01 — Devin: revisão manual dos achados Slither High/Medium com aprovação do solicitante registrada em `docs/audit-repost-qr-clain.md` (auditoria manual aprovada em 01/11/2026 20:30). `arbitrary-send-eth` em `_transferAsset`: o destinatário vem da `ClaimAuthorization` assinada pelo `claimSigner` (EIP-712 com nonce e deadline) — comportamento pretendido do voucher, não depósito arbitrário de terceiros. `incorrect-equality` em `received == 0`: medição por delta de saldo é deliberada para suportar tokens com fee-on-transfer; o custo é apenas revert em depósito vazio. Riscos residuais aceitos pelo solicitante; auditoria externa independente segue como pendência documentada.
- [x] 2026-11-01 — Devin: simulação do upgrade em **fork da Polygon mainnet** executada (`scripts/fork/claim_facets_fork.ts`, `HARDHAT_FORK_URL` + chainId 137, bloco ~96580593): deploy dos dois facets, colisão de seletores (35 livres), `scheduleBatch` pela Safe real impersonada, avanço de 48h, `executeBatch` e verificações — todos os seletores mapeados, `getClaimSigner`, `isClaimAssetSupported(CAS)`, ativo nativo, `name`/`symbol` e interfaces ERC-721/ERC-5192 no ERC-165. **Resultado: PASS**.
- [x] 2026-11-01 — Devin: Mythril/Echidna, fuzzing e cobertura ≥90% **permanecem pendentes** e registrados como débito de auditoria — não bloquearam o deploy por decisão expressa do solicitante (ver `audit-repost-qr-clain.md`).
- [x] 2026-11-01 — Devin: payload de governança preparado e agendado sem contornar controles — fluxo Safe 2-de-3 → Timelock (48h) → Diamond existente. Script `50_deploy_claim_facets.ts` (corte direto por EOA) **não utilizado**; substituído por `52_prepare`/`53_schedule`/`54_execute`.
- [x] 2026-11-01 — Devin: **deploy e agendamento realizados em mainnet.** ClaimVaultFacet `0x58E60E16F7d20Fdd7F960e6680F3671B2a0b0f78` (tx `0xf328218a99b811a9ba50a36b09c4f220ac86b3bdd046ebe710a4113837c0a374`); ClaimNFTFacet `0xED8e0d8364509aaaC0d0197158E3908BDB8Ca45D` (tx `0xd16268d70e9973cd855e480f3a86dd02b23f79f12c604f764e907ffb268a2367`); deployer `0x66682BBeD9e540017967692cCdd069fE5F833888`. Safe execTransaction tx `0x97a9ca8f5c87288d031a6364b1eebd2ad9d5fa7c15a54e9fe195bcf828020178` (nonce 19). operationId `0x4aa51e471289c2631eabf59eef9236d31723a15ba98cf33ad844aab5a4fd357b`, readyAt `2026-11-03T23:45:57Z`. Payload em `deployments/claim-facets-cut.json`. Execução automática agendada via `agenticspace-claim-facets-execute.timer` (23:50 UTC, retry 15min) — o script `54_execute` remove as units ao concluir. Batch: diamondCut (35 seletores) + `initClaimVault(0x1cdF56D75d5F3643BecB1Cb2F96cbEC26a43c73c)` + `initClaimNFT("Rapport Claim","RCLAIM",baseURI)` + `setClaimAssetSupport(CAS 0x5151A34EaC7bA08cd6B540b32cD30316218A2287)`.
- [ ] Pós-execução (após 2026-11-03): verificação no PolygonScan, registro no `ContractRegistry`, monitoramento e atualização backend/frontend com os endereços confirmados — **pendente até a execução do timelock**.

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

> [!note] EIP-8004/8183/x402 (2026-08-24)
> As novas facets seguem o padrão `DiamondAccessControl.enforceRoleOrOwner`
> já existente: `resolveDispute`/`setProtocolFeeBps`/`setDisputeWindow`/
> `setNegotiationBounds` (`AgentCommerceFacet`) exigem `COMMERCE_ARBITER_ROLE`;
> `setX402ProtocolFeeBps`/`settleWithAuthorization` (`X402FacilitatorFacet`)
> exigem `X402_RELAYER_ROLE`; `submitValidation` (`ValidationRegistryFacet`)
> exige `VALIDATOR_ROLE`. Ambas as novas roles herdam o mesmo bypass de
> owner já apontado como **M-8**/**M-2** na auditoria de 2026-07-14 (o
> owner sempre passa em `enforceRoleOrOwner`) — risco pré-existente, não
> introduzido por este código, mas não corrigido por ele. `initAgentCommerce`
> e `initX402` são owner-only (`enforceIsContractOwner`) e protegidos contra
> reexecução por `AlreadyInitialized`, então **não** reproduzem o achado
> **C-1** (init*() sem auth) da auditoria anterior.

---

## 4. Autenticação e assinaturas

- [x] **[CRÍTICO]** Não utilizar somente `msg.sender` quando a operação depende de uma assinatura externa. — `X402FacilitatorFacet.settleWithAuthorization` exige `signature` + `ECDSA.recover`; `payDirect` usa apenas `msg.sender` legitimamente, pois não há terceiro relayando (ver `docs/x402-facilitator.md`)
- [x] Utilizar mensagens estruturadas com EIP-712. — `X402Authorization(address payer,address payee,bytes32 requestHash,uint256 amount,uint256 deadline)` via `SignatureLib`
- [x] Incluir domínio de assinatura (nome, versão, chainId, endereço do contrato). — `SignatureLib.domainSeparator(name, version)` inclui `block.chainid` e `address(this)`, calculado em tempo de chamada (nunca `immutable`) — ver nota dedicada abaixo
- [ ] Incluir um nonce único. — **Nota:** x402 usa `requestHash` (hash da requisição HTTP off-chain) em vez de nonce sequencial, deliberadamente — ver `docs/x402-facilitator.md#requestHash como Chave Anti-Replay`; item não marcado por não ser um nonce incremental clássico
- [x] Incluir prazo de validade (deadline). — `deadline` em `payDirect` e `settleWithAuthorization`, checado com `DeadlineExpired`
- [x] Marcar o nonce como consumido após a execução. — `usedRequests[payer][requestHash] = true` marcado **antes** das transferências (CEI)
- [ ] Impedir replay em outra blockchain. — coberto pelo domain separator (`block.chainid`), mas sem teste cross-chain dedicado
- [ ] Impedir replay em outro contrato. — coberto pelo domain separator (`address(this)`), mas sem teste dedicado
- [x] Impedir replay após upgrade ou mudança de versão. — domain separator recalculado a cada chamada via `address(this)`/`block.chainid` reais (nunca cacheado), evitando o pitfall clássico de Diamond + EIP-712 `immutable` — ver `docs/x402-facilitator.md`
- [x] Verificar o endereço recuperado pela assinatura. — `signer != payer` reverte com `InvalidSignature`
- [ ] Rejeitar endereço zero. — não há checagem explícita de `payer != address(0)` antes do `recover` (mitigado indiretamente: `ECDSA.recover` de assinatura válida nunca retorna endereço zero, mas não há teste dedicado)
- [ ] Verificar assinaturas de carteiras inteligentes com ERC-1271. — não implementado; apenas EOAs via `ECDSA.recover`
- [ ] Não assumir que todo usuário é uma EOA. — **pendência:** payers com smart-contract wallet (ERC-4337/Safe) não conseguem assinar via `ECDSA.recover` puro
- [x] Utilizar bibliotecas consolidadas para ECDSA. — `@openzeppelin/contracts/utils/cryptography/ECDSA.sol`
- [x] Verificar malleability da assinatura. — `ECDSA.recover` da OpenZeppelin rejeita assinaturas com `s` alto (malleable)
- [x] Garantir que o conteúdo assinado corresponda exatamente à operação executada. — `structHash` inclui todos os parâmetros efetivamente usados em `_settle` (`payer, payee, requestHash, amount`) mais `deadline`

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

> [!note] Eip8004Storage (2026-08-24)
> `IdentityRegistryFacet.metadataURI` armazena apenas uma **URI** (endereço
> do agent card off-chain), nunca o conteúdo do card. `ReputationRegistryFacet`
> armazena apenas `commentHash` (hash do comentário, nunca o texto).
> `ValidationRegistryFacet` armazena apenas `workHash`/`reportHash`, nunca o
> trabalho nem o relatório em si. Nenhum dado pessoal é gravado em texto
> aberto pelas 3 facets do Trust Layer EIP-8004.

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

- [x] **[CRÍTICO]** Identificar todas as chamadas externais. — mapeadas em todos os contratos; em `AgentCommerceFacet`: `safeTransferFrom`/`safeTransfer` em `fundJob`, `_settle`, `resolveDispute`; em `X402FacilitatorFacet`: `safeTransferFrom` em `_settle`
- [x] Aplicar o padrão Checks–Effects–Interactions. — UserRegistryFacet documenta CEI; **`AgentCommerceFacet`** finaliza `state`/`fundedAmount`/`updatedAt` do `Offer` **antes** de qualquer `safeTransfer`/`safeTransferFrom` em `fundJob`, `_settle` e `resolveDispute`; **`X402FacilitatorFacet._settle`** marca `usedRequests[payer][requestHash] = true` **antes** das duas `safeTransferFrom` (net ao payee, fee ao fundo) — ver `docs/eip8183-agent-commerce.md#Escrow, CEI e Segurança` e `docs/x402-facilitator.md#Segurança`
- [ ] Utilizar `ReentrancyGuard` em operações sensíveis. — **A-3:** PaymentFacet sem guard, **A-4:** Faucet sem guard, **M-5:** UserRegistryFacet sem guard. `AgentCommerceFacet`/`X402FacilitatorFacet` também não usam `ReentrancyGuard` explícito, mitigado pelo CEI acima e pelo CAS ser um ERC-20 OZ padrão sem callbacks — ainda assim, não foi validado por fuzzing/echidna (ver pendência de ferramentas)
- [ ] Não proteger apenas a função principal; analisar reentrância entre funções diferentes. — não testado formalmente para o novo código (ex.: reentrância cruzada entre `fundJob` e `cancelOffer`)
- [ ] Avaliar reentrância de somente leitura. — não avaliado
- [x] Atualizar saldos antes da transferência. — CEI em UserRegistryFacet e no novo código (ver acima)
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

> [!note] EIP-8004/8183/x402 (2026-08-24)
> As 5 novas facets emitem evento em **toda** função de mutação de
> estado: `AgentMetadataUpdated`, `FeedbackSubmitted`,
> `ValidationRequested`/`ValidationSubmitted`,
> `AgentCommerceInitialized`/`OfferCreated`/`OfferNegotiated`/
> `OfferAccepted`/`OfferCancelled`/`JobFunded`/`JobDelivered`/
> `JobSettled`/`DisputeRaised`/`DisputeResolved`,
> `X402Initialized`/`PaymentSettled`. Todos os erros usam `error` customizado
> (nunca `require(string)`), reduzindo custo de gas e mantendo mensagens
> estruturadas — ver seções "Events"/"Errors" de cada documento em
> `docs/eip8004-trust-layer.md`, `docs/eip8183-agent-commerce.md` e
> `docs/x402-facilitator.md`.

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
- [x] Adicionar novas variáveis somente no final. — allowMultipleIssuance, maxPerRecipient, maxTotalSupply appendados ao final do struct Phase
- [x] Testar atualização com estado real previamente criado. — RapportCertificateUpgradeSafety.test.ts simula upgrade do bytecode verificado em mainnet → novo split, confirmando preservação de fases, certificados e depósitos CAS
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

> [!note] EIP-8004/8183/x402 (2026-08-24)
> `test/diamond/Eip8004Eip8183X402.test.ts` cobre as 5 novas facets via
> Diamond real (não chamadas diretas na implementação): 14 testes, todos
> passando. Cobre caminho feliz completo de `AgentCommerceFacet`
> (offer → negotiate → accept → fund → deliver → settle), clamp de
> negociação fora dos limites, fluxo de disputa/resolução, feedback
> backed por job liquidado e rejeição de feedback não backed, `payDirect`,
> replay de `requestHash`, `settleWithAuthorization` válido, assinatura de
> terceiro (rejeitada) e chamada de não-relayer (rejeitada). **Não há**
> testes de fuzzing/invariantes/reentrância dedicados a este código —
> apenas os casos deterministas acima.

- [x] Testar caminho feliz. — testes existem para token contracts; `AgentCommerceFacet`/`X402FacilitatorFacet` cobertos em `Eip8004Eip8183X402.test.ts`
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
- [x] Testar upgrade. — RapportCertificateUpgradeSafety.test.ts + RapportCertificateMultipleIssuance.test.ts
- [x] Testar manutenção do estado após upgrade. — 50 testes passando, incluindo regressão single-issuance
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

> [!warning] Pendência — EIP-8004 / EIP-8183 / x402 (2026-08-24)
> As 8 contratos novos (`Eip8004Storage`, `CommerceStorage`, `X402Storage`,
> `SignatureLib`, `IdentityRegistryFacet`, `ReputationRegistryFacet`,
> `ValidationRegistryFacet`, `AgentCommerceFacet`, `X402FacilitatorFacet`)
> **ainda não foram submetidos a Slither, Mythril ou Echidna**. Até o
> momento, a única validação realizada foi revisão manual do código-fonte
> mais a suíte de testes automatizados
> (`test/diamond/Eip8004Eip8183X402.test.ts`, 14 testes passando). Isso
> **não constitui** uma auditoria de segurança completa nem substitui
> análise estática (Slither), análise simbólica (Mythril) ou
> fuzzing/testes de invariantes (Echidna/Foundry). **Executar as três
> ferramentas contra este código é um pré-requisito obrigatório antes de
> qualquer deploy em mainnet**, seguindo a mesma prioridade 9 ("Fuzzing e
> testes de invariantes") já listada acima.

---

## Histórico de revisões

| Data | Responsável | Contratos revisados | Alterações |
|------|------------|---------------------|------------|
| 2026-09-19 | Devin | CASSwapUSDCPOLFacet, LibCASSwap, CASSwapStorage, ICASSwapUSDCPOL | Multi-ativo: BRLA + `swapExact`/`quoteSwap` genérico (12 direções, CAS pivot), `setAllSwapRatiosV2`, views `getCasRate`/`getReservesMulti`/`getBRLAToken`. 18 testes novos + 33 regressão passando. Slither/Mythril/Echidna **pendentes** antes do deploy do corte multi-ativo. |
| 2026-09-17 | Devin | CASSwapUSDCPOLFacet, LibCASSwap, ICASSwapUSDCPOL, TraderGovernanceFacet | Fix da suíte CASSwap: 29 testes passando, colisão de seletores resolvida, slither direcionado sem HIGH/CRITICAL, Mythril sem achados. Echidna bloqueado por falta de Foundry no ambiente. |
| 2026-08-24 | Devin | 8 contratos (EIP-8004 Trust Layer + EIP-8183 AgentCommerceFacet + x402 Facilitator) | Revisão manual + verificação da suíte de testes (`Eip8004Eip8183X402.test.ts`, 14 passing). Itens marcados em Controle de Acesso, Autenticação/Assinaturas (EIP-712), Reentrância/CEI e Privacidade. Slither/Mythril/Echidna **não executados** — pendência registrada para pré-mainnet. |
| 2026-07-14 | _Inicial_ | — | Criação do arquivo espelho conforme regra `solidity-security.md` |
| 2026-07-14 | Cascade (AI) | 40+ contratos | Revisão manual completa. 2 CRÍTICO, 9 ALTO, 8 MÉDIO. Ver `security-audit-2025-07-14.md` |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
