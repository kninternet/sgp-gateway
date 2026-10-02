# sgp-gateway

Ponto único de acesso dos canais de atendimento (n8n / Vitor) ao SGP.
Multi-tenant: cada marca é um tenant com token SGP, POPs permitidos e base própria (schema).

## Garantias de segurança

- **Lista fechada de rotas SGP**, só leitura (`src/sgp/client.ts`).
- **Chave por canal**: cada canal aponta para UM tenant e UM POP. Só o hash sha256 é gravado.
- **Trava de POP em duas camadas**: o contrato precisa existir na base própria no POP do canal,
  e a resposta do SGP é conferida de novo (título/contrato divergente é descartado).
- **Identificação por telefone** só em canal com telefone verificado (`--telefone`). Webchat: só CPF/CNPJ.
- **Senhas do SGP nunca são gravadas** (central, PPPoE, Wi-Fi, ONU).
- **Auditoria** de toda chamada em `gateway.auditoria`.
- Rede: escuta só no IP público da .241; UFW libera a porta apenas para a .239; `ALLOWED_IPS` repete a regra na aplicação.

## Rotas (POST, header `x-gateway-key`)

| Rota | Corpo | Fonte |
|---|---|---|
| `/v1/identificar` | `{cpfcnpj}` ou `{telefone}` | base própria |
| `/v1/faturas` | `{contrato_id}` | SGP ao vivo (`ura/titulos`) |
| `/v1/segunda-via` | `{contrato_id}` | SGP ao vivo (`ura/fatura2via`) |
| `/v1/pix` | `{contrato_id, fatura_id}` | SGP ao vivo (`ura/pagamento/pix`) |

`GET /health` sem autenticação.

## Operação

```bash
pnpm install && pnpm build
pnpm migrate                      # idempotente: schema gateway + schema de cada tenant
pnpm sync                         # carga da base própria (PM2 repete a cada hora)
pnpm canal:add --tenant vivanet --nome webchat --pop 100072
pm2 start ecosystem.config.cjs && pm2 save
```

Deploy: `git pull origin main && pnpm install && pnpm build && pnpm migrate && pm2 restart sgp-gateway --update-env`

## Novo tenant

1. `INSERT` em `gateway.tenants` (novo `schema_name`, `sgp_token_env`, `pops_permitidos`).
2. Variável do token no `.env`.
3. `pnpm migrate` cria o schema; `pnpm sync` carrega a base; `pnpm canal:add` cria os canais.
