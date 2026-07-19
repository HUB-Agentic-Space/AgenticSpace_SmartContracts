# Certificados Rapport — ERC-721 + ERC-6551

## Visão geral

`RapportCertificate` emite certificados ERC-721 não transferíveis (ERC-5192).
Cada certificado possui uma conta ERC-6551 determinística (TBA) que recebe o
aporte mínimo de CAS durante a mesma transação de emissão.

- Emissor legal: **Raport Tecnologia Inova Simples**
- CNPJ: **67.904.299/0001-80**
- Sites: `https://rapport.tec.br` e `https://agenticspace.rapport.tec.br`
- Rede alvo: Polygon PoS
- Fase inicial: **Sócio Fundador**
- Aporte/custo inicial: **50 CAS**
- Registry canônico ERC-6551 v0.3.1:
  `0x000000006551c19487814612e58FE06813775758`

O aporte não é uma taxa: os CAS são enviados diretamente para a TBA e ficam
sob controle do titular do NFT. O titular pode retirá-los posteriormente por
`RapportCertificateAccount.execute`. A tela de verificação deve distinguir
`casDeposited` (aporte feito na emissão) de `currentCasBalance` (saldo atual).
Como reconhecimento adicional, um gestor autorizado pode pagar uma única vez
um bônus do mesmo valor diretamente à carteira do titular. Esse pagamento usa
CAS do próprio gestor/tesouraria e não retira nem movimenta a reserva da TBA.

Para manter uma fonte central de consulta, o `PaymentFacet` cataloga esse
requisito como `FEE_TYPE_CERTIFICATE_ISSUANCE = 6`, com valor inicial de
50 CAS. Esse registro alimenta páginas de taxas e auditoria, mas não executa
`PaymentLib.processFeePayment`: a movimentação ocorre somente uma vez, no
`RapportCertificate`, com destino à TBA do titular.

## Contratos

| Arquivo | Responsabilidade |
|---|---|
| `contracts/certificate/RapportCertificate.sol` | NFT, fases, autorização EIP-712, aporte CAS, revogação e hash do PDF |
| `contracts/certificate/RapportCertificateAccount.sol` | TBA ERC-6551/ERC-1271 com execução limitada a `CALL` |
| `contracts/certificate/ERC6551Registry.sol` | Registry de referência v0.3.1 para testes/redes explicitamente autorizadas sem o singleton |
| `contracts/interfaces/IERC5192.sol` | Interface soulbound |
| `contracts/interfaces/IERC6551*.sol` | Interfaces oficiais ERC-6551 |

O certificado é standalone e deliberadamente não usa UUPS ou Diamond. Novas
fases são dados administráveis, portanto não exigem upgrade da coleção. O
endereço pode ser registrado no `ContractRegistryFacet` como
`RapportCertificate`.

## Autorização de emissão

O backend confirma a inscrição e os dados do usuário, então assina uma
autorização EIP-712 de curta duração. O usuário chama o contrato, paga o gas e
autoriza a transferência dos CAS.

Domain EIP-712:

```text
name:              RapportCertificate
version:           1
chainId:           chain atual
verifyingContract: endereço de RapportCertificate
```

Primary type e ordem exata dos campos:

```text
CertificateMintAuthorization(
  bytes32 issuanceId,
  address recipient,
  bytes32 nameHash,
  uint256 phaseId,
  bytes32 metadataHash,
  uint256 casAmount,
  uint256 nonce,
  uint256 deadline
)
```

`issuer` deve possuir `ISSUER_ROLE`. A validação usa `SignatureChecker`, logo
aceita tanto EOA quanto contrato compatível com ERC-1271. `issuanceId` é global
e de uso único; `nonce` é sequencial por destinatário; há no máximo um
certificado por destinatário em cada fase.

Fluxo:

1. Backend lê `nonces(recipient)`, `currentPhaseId()` e `getPhase(phaseId)`.
2. Backend gera `issuanceId`, `nameHash` e `metadataHash`, define prazo curto e
   assina a autorização.
3. Usuário aprova `casAmount` no CAS para o endereço do certificado.
4. Usuário chama `mintCertificate(authorization, issuer, signature)`.
5. O contrato cria a TBA pelo registry, transfere CAS diretamente para ela,
   cunha o NFT e verifica novamente o saldo.
6. O backend confirma `CertificateMinted` e `issuanceUsed(issuanceId)`.

Antes de movimentar CAS, o contrato compara o endereço previsto por `account`
com o retornado por `createAccount` e valida o `codehash` completo do proxy
ERC-6551 v0.3.1. O hash cobre o implementation, salt, chain ID, coleção e token
ID; um registry incompatível faz a emissão reverter sem transferir fundos.

O nome em texto não é armazenado on-chain. `nameHash` deve ser calculado a
partir da forma canônica definida pelo backend (por exemplo, Unicode NFC,
espaços normalizados e UTF-8) e nunca diretamente de texto sem normalização.

## Fases

A fase `Sócio Fundador` é criada e ativada no construtor. O dashboard administra
as próximas fases com:

- `createPhase(name, templateHash, minCasDeposit, startsAt, endsAt)`
- `activatePhase(phaseId)`
- `deactivateCurrentPhase()`
- `getPhase(phaseId)`
- `currentPhaseId()` e `phaseCount()`

Configurações de fase são imutáveis depois de criadas. Para corrigir ou mudar
um tipo de certificado, crie uma nova fase. O `name` vira o tipo/título visível
do novo diploma e `templateHash` identifica a versão de sua arte. Ativar uma
fase desativa a anterior, mas certificados antigos continuam válidos.

## Bônus de CAS

Depois da emissão, uma conta com `BONUS_MANAGER_ROLE` pode devolver ao titular
o mesmo montante registrado em `casDeposited`:

```solidity
grantCasBonus(tokenId)
```

O gestor é também o pagador: antes da chamada, deve aprovar o endereço de
`RapportCertificate` no token CAS. A função usa `safeTransferFrom(msg.sender,
recipient, casDeposited)`, paga diretamente a carteira do titular e emite
`CasBonusGranted(tokenId, recipient, paidBy, amount)`.

`casBonusGranted(tokenId)` registra a operação on-chain e impede pagamento
duplo. Falta de saldo/allowance ou recebimento abaixo do valor integral reverte
toda a transação, inclusive o marcador. A função é bloqueada durante pausa e
nunca chama a TBA, portanto o bônus não depende do saldo CAS atual da conta
ERC-6551.

## PDF, SVG e assinatura gov.br

`metadataHash` ancora os metadados canônicos preparados pelo backend. O SVG
incorpora um manifesto verificável e o frontend o converte em PDF A4; ambos são
comparados ao registro on-chain na página pública. Após assinatura
gov.br/ICP-Brasil, os bytes mudam; calcule SHA-256 do PDF final assinado e
registre-o uma única vez com:

```solidity
attestDocumentHash(tokenId, sha256Pdf)
```

A verificação por upload calcula SHA-256 do arquivo e chama
`verifyDocument(hash)`. Ela também deve validar a assinatura PAdES/ICP-Brasil
off-chain; um hash on-chain prova integridade e vínculo com o emissor, mas não
substitui a validação da cadeia de certificados do gov.br.

## Revogação e TBA

`revokeCertificate(tokenId, reasonHash)` invalida o certificado sem queimar o
NFT. Isso é intencional: queimar um NFT ERC-6551 poderia deixar os ativos da TBA
sem controlador. A revogação também não confisca nem bloqueia os CAS.

`RapportCertificateAccount` implementa:

- ERC-6551 Account (`token`, `state`, `isValidSigner`)
- ERC-6551 Executable, apenas operação `0 = CALL`
- ERC-1271 para assinatura do titular
- ERC-165

`DELEGATECALL`, `CREATE` e `CREATE2` revertem. A conta possui proteção contra
reentrância e só aceita `execute` quando `msg.sender` é o proprietário atual do
NFT.

## Deploy

Variáveis mínimas:

```env
CAS_TOKEN_ADDRESS=0x...
DIAMOND_ADDRESS=0x...
CERTIFICATE_ADMIN_ADDRESS=0x...
CERTIFICATE_ISSUER_ADDRESS=0x...
CERTIFICATE_PHASE_MANAGER_ADDRESS=0x...
CERTIFICATE_REVOKER_ADDRESS=0x...
CERTIFICATE_PAUSER_ADDRESS=0x...
CERTIFICATE_BONUS_MANAGER_ADDRESS=0x...
CERTIFICATE_BASE_URI=https://agenticspace.rapport.tec.br/api/v1/certificates/token/
ERC6551_REGISTRY_ADDRESS=0x000000006551c19487814612e58FE06813775758
ALLOW_LOCAL_ERC6551_REGISTRY=false
```

Em um Diamond existente que já exponha o catálogo extensível, registre o tipo
6 sem reinicializar as taxas-base:

```bash
npm run register:certificate-fee:polygon
```

O script exige `DIAMOND_ADDRESS` e uma chave do owner em
`RELAYER_PRIVATE_KEY` (ou usa o signer padrão do Hardhat), é idempotente e
confirma que `getCustomFee(6) == 50e18` e que o ID aparece uma única vez em
`getAllFeeTypes()`.

Em uma rede pública, o script exige o endereço singleton canônico e aborta se
não encontrar bytecode nele. Isso evita aceitar silenciosamente outro contrato,
trocar a identidade do registry e quebrar a interoperabilidade das contas. O
fallback local é automático apenas na chain Hardhat `31337`. O opt-in explícito
`ALLOW_LOCAL_ERC6551_REGISTRY=true` existe somente para redes locais ou de teste
controladas que não possuam o singleton; não deve ser usado em produção.

Comandos:

```bash
npm run deploy:certificate:amoy
npm run deploy:certificate:polygon
npm run register:certificate-fee:polygon
npm run register:certificate:diamond:polygon
npm run finalize:certificate-roles:polygon
```

Em uma implantação existente, registre primeiro a taxa extensível tipo `6`
(50 CAS). O registro no `ContractRegistryFacet` e a remoção dos papéis bootstrap
usam `RELAYER_PRIVATE_KEY`, quando presente, para que o owner/admin final assine
as transações. Os scripts são idempotentes e verificam bytecode e estado depois
de cada mudança. Carregue a chave por variável de ambiente; nunca a grave em
logs ou em arquivos versionados.

O deploy exige um endereço explícito para cada role. O deployer é admin
bootstrap apenas para atribuí-las: `CERTIFICATE_ADMIN_ADDRESS` recebe
`DEFAULT_ADMIN_ROLE`, enquanto emissor, gestor de fases, revogador, pausador e
gestor de bônus recebem exclusivamente seus alvos configurados. Endereços iguais
são aceitos quando essa concentração de privilégios for deliberada.

Antes de registrar a coleção no Diamond, o script 14 confirma a chain Polygon
`137`, identidade `Rapport Certificate`/`RPTCERT`, token CAS tanto na coleção
quanto no `PaymentFacet`, registry ERC-6551 singleton, bytecode da implementação
da TBA, fase 1 `Sócio Fundador` com 50 CAS, ERC-5192, dados jurídicos/sites e
todas as roles configuradas. Fora da Polygon ele só executa com
`ALLOW_NON_POLYGON_CERTIFICATE_REGISTRATION_FOR_TESTS=true`, reservado a um
ambiente isolado de testes; as demais invariantes continuam obrigatórias.

Para encerrar o bootstrap, informe também
`CERTIFICATE_BOOTSTRAP_ADMIN_ADDRESS`. O script 15 enumera os membros das seis
roles e aborta antes da primeira transação se encontrar uma conta diferente do
alvo configurado ou do bootstrap conhecido. Ele preserva o bootstrap somente
nas roles cujo alvo configurado seja o próprio bootstrap, revoga-o das demais e
confirma que cada role terminou com exatamente um membro. Assim,
`DEFAULT_ADMIN_ROLE` pode permanecer no deployer quando essa for a configuração
deliberada, sem manter nele as roles operacionais.

Depois do deploy, publique o mesmo endereço da coleção como
`RAPPORT_CERTIFICATE_ADDRESS` nos scripts de contratos,
`CERTIFICATE_CONTRACT_ADDRESS` no backend e
`NEXT_PUBLIC_CERTIFICATE_ADDRESS` no frontend.

## Verificação e testes

```bash
npx hardhat test test/certificate/RapportCertificate.test.ts
npm test
```

Os testes cobrem registry determinístico, EIP-712/anti-replay, aporte CAS,
bônus único e sua autorização/allowance, fases, pausa, ERC-5192, revogação,
hash do PDF, execução CALL-only e ERC-1271/165/6551.

## Riscos residuais

- Perda da chave do titular também perde o controle da TBA; não há recuperação
  administrativa que possa transferir os CAS unilateralmente.
- O signer do backend pode autorizar nomes/metadados incorretos; mantenha
  `ISSUER_ROLE` separado do admin e monitore eventos.
- O admin pode pausar emissões, criar fases e revogar certificados. Use Safe
  multisig e, idealmente, timelock para mudanças operacionais sensíveis.
- ERC-6551 ainda está em status Review. O endereço do registry, o bytecode do
  account implementation e o `ACCOUNT_SALT` devem ser tratados como parte da
  identidade permanente da coleção.
- O CAS pode ser pausado; nesse estado novas emissões que exigem transferência
  falham, mas TBAs e certificados existentes continuam consultáveis.
