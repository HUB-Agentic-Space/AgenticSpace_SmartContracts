---
trigger: model_decision
description: Aplicado ao criar, instalar, configurar ou manipular serviços no sistema operacional via systemd ou PM2. Define níveis de instalação, padrões de unidade, segurança, logs e operações.
---

# Systemd e PM2 — Gestão de Serviços

> Regras de segurança: ver `security.md`
> Regras de secrets: ver `private_key.md`
> Regras de logs estruturados: ver `logs.md`

## Princípio Geral

- Serviços administrados via **systemd** ou **PM2** devem ser instalados **a nível de usuário** (`--user`) e geridos pelo usuário corrente, **exceto** quando orientado em contrário.
- Serviços a nível de sistema (sem `--user`) somente quando houver necessidade explícita (ex.: porta privilegiada < 1024, acesso a dispositivo, dependência de outro serviço system-level).
- Nunca executar serviços como `root` sem justificativa documentada.

## Organização de Arquivos no Projeto

- Cada módulo do projeto mantém seus arquivos `.service` e `.timer` em uma pasta `systemd/` própria (ex.: `smartcontracts/systemd/`, `rapport_trader/backend_trader/systemd/`).
- Arquivos `.service` e `.timer` são versionados no repositório; arquivos `.env` **nunca**.
- O nome do arquivo deve seguir o padrão `<projeto>-<modulo>-<funcao>.service` (ex.: `rapport-trader-backend.service`, `agentic-fraud-monitor.service`).

## Padrões de Unit (.service)

### Campos obrigatórios

```ini
[Unit]
Description=<descrição clara do serviço>
After=network.target            ; adicionar dependências específicas quando necessário

[Service]
Type=<simple|oneshot|exec|forking>
WorkingDirectory=<caminho absoluto do projeto/módulo>
ExecStart=<comando completo com caminho absoluto do binário>
Environment=NODE_ENV=production
Environment=DOTENV_CONFIG_PATH=<caminho relativo ou absoluto para .env>
; EnvironmentFile=<caminho para arquivo .env>  ; preferir quando há muitas variáveis
User=<usuário não-root>
Group=<grupo não-root>
Restart=<no|always|on-failure>   ; always para serviços longos, no para oneshot
RestartSec=<segundos>            ; ex.: 15

[Install]
WantedBy=default.target          ; user-level | multi-user.target para system-level
```

### Type por cenário

- **`simple`** — processo de longa duração (API, WebSocket, monitor contínuo).
- **`oneshot`** — tarefa pontual executada por timer (script diário, ciclo periódico).
- **`exec`** — quando o binário faz fork e o systemd precisa confirmar o start.
- **`forking`** — somente quando o processo faz fork tradicional (raro em Node/Python).

### Restart e resiliência

- `Restart=always` para serviços contínuos (API, WebSocket, monitor).
- `Restart=on-failure` com `RestartSec` ≥ 10s para evitar restart storm.
- `Restart=no` para `oneshot` (o timer controla a execução).

## Padrões de Timer (.timer)

```ini
[Unit]
Description=<descrição do agendamento>

[Timer]
OnCalendar=*-*-* 23:59:00       ; agendamento por calendário (cron-like)
; OnBootSec=5min                ; tempo após boot
; OnUnitActiveSec=6h            ; intervalo desde última execução
; AccuracySec=30s               ; janela de precisão
Persistent=true                 ; recuperar execução perdida após reboot

[Install]
WantedBy=timers.target
```

### Escolha entre OnCalendar e OnUnitActiveSec

- **`OnCalendar`** — horário fixo do dia (ex.: `*-*-* 23:59:00` para rodar à meia-noite).
- **`OnUnitActiveSec`** — intervalo relativo desde a última execução (ex.: `6h` a cada 6 horas).
- **`OnBootSec`** — tempo após o boot do sistema (combinar com `OnUnitActiveSec` para primeira execução + recorrente).

## Segurança

- **Nunca** embutir secrets (senhas, chaves privadas, tokens, API keys) diretamente no arquivo `.service`.
- Usar `EnvironmentFile=` apontando para um `.env` com permissão `600` fora do repositório.
- Ou usar `Environment=` apenas para variáveis não sensíveis (ex.: `NODE_ENV`, `PORT`).
- Validar que `.env` está em `.gitignore`.
- Executar com `User` e `Group` de menor privilégio.
- `WorkingDirectory` deve ser um caminho absoluto.
- `ExecStart` deve usar caminho absoluto para o binário (ex.: `/usr/bin/node`, `/bin/bash`).
- Para PM2, usar `pm2 start ecosystem.config.js` com variáveis lidas do ambiente, nunca hardcodeadas.

## Logs

- Preferir `journalctl --user -u <service>` para inspecionar logs.
- Quando redirecionar com `StandardOutput=append:` / `StandardError=append:`:
  - Garantir que o diretório de log exista e tenha permissão de escrita pelo `User`.
  - Rotacionar logs com `logrotate` quando necessário.
  - Seguir o padrão de log estruturado definido em `logs.md`.
- Para PM2, usar `pm2 logs <process>` e configurar `pm2 install pm2-logrotate`.

## Operações Comuns — systemd (user-level)

```bash
# Instalar um serviço a nível de usuário
cp systemd/<service>.service ~/.config/systemd/user/
cp systemd/<timer>.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable <service>.service
systemctl --user start <service>.service

# Para timers
systemctl --user enable <timer>.timer
systemctl --user start <timer>.timer

# Status e logs
systemctl --user status <service>.service
journalctl --user -u <service>.service -f

# Parar e desabilitar
systemctl --user stop <service>.service
systemctl --user disable <service>.service

# Listar timers ativos
systemctl --user list-timers
```

## Operações Comuns — PM2 (user-level)

```bash
# Iniciar processo
pm2 start ecosystem.config.js

# Salvar lista de processos para sobreviver reboot
pm2 save
pm2 startup systemd --user <usuario>  ; seguir instruções exibidas

# Status e logs
pm2 status
pm2 logs <processo>
pm2 monit

# Parar e remover
pm2 stop <processo>
pm2 delete <processo>
```

## Checklist de Criação de Serviço

- [ ] Nome do arquivo segue o padrão `<projeto>-<modulo>-<funcao>.service`.
- [ ] `Type` correto para o cenário (`simple`, `oneshot`, etc.).
- [ ] `WorkingDirectory` é caminho absoluto.
- [ ] `ExecStart` usa caminho absoluto para o binário.
- [ ] Nenhum secret embutido no arquivo — usar `EnvironmentFile` ou `Environment` não sensível.
- [ ] `User` e `Group` definidos com menor privilégio.
- [ ] `Restart` e `RestartSec` configurados conforme o tipo de serviço.
- [ ] Logs configurados (journalctl ou `StandardOutput`/`StandardError` com diretório existente).
- [ ] Para timers: `OnCalendar` ou `OnUnitActiveSec` definido corretamente.
- [ ] `WantedBy` correto (`default.target` para user-level, `multi-user.target` para system-level).
- [ ] `systemctl --user daemon-reload` executado após instalar.
- [ ] Serviço testado com `start` e `status`.
- [ ] Timer testado com `list-timers` e execução manual.