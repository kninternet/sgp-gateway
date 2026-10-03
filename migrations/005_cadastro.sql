-- Cadastro de novos clientes pelo Vitor.
-- Credencial de ESCRITA separada da de leitura (só usada pela rota /v1/cadastro).
ALTER TABLE gateway.tenants ADD COLUMN IF NOT EXISTS sgp_write_app text;
ALTER TABLE gateway.tenants ADD COLUMN IF NOT EXISTS sgp_write_token_env text;
UPDATE gateway.tenants
   SET sgp_write_app = COALESCE(sgp_write_app, 'falcone'),
       sgp_write_token_env = COALESCE(sgp_write_token_env, 'SGP_WRITE_TOKEN_VIVANET')
 WHERE id = 'vivanet';

-- Só canais marcados podem cadastrar.
ALTER TABLE gateway.canais ADD COLUMN IF NOT EXISTS permite_cadastro boolean NOT NULL DEFAULT false;
