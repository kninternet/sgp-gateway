-- Tenant Viva Net. POP 22 = validação, POP 100072 = produção.
-- sgp_app 'falcone' é provisório: trocar quando o token dedicado existir.
INSERT INTO gateway.tenants
  (id, nome, sgp_base_url, sgp_app, sgp_token_env, schema_name, pops_permitidos, empresa_cnpj, gerar_os_2via)
VALUES
  ('vivanet', 'Viva Net Telecom', 'https://netecom.sgplocal.com.br', 'vivanet-gateway',
   'SGP_TOKEN_VIVANET', 'vivanet', '{22,100072}', NULL, false)
ON CONFLICT (id) DO NOTHING;
