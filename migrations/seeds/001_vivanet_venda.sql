-- Cobertura e condições de venda da Viva Net. Idempotente: reflete o estado desejado.
-- Vendas novas vão todas para o POP 22 (um plano só).
DELETE FROM vivanet.cobertura   WHERE (pop_id = 22 AND bairro = 'Pavuna') OR pop_id = 100072;
DELETE FROM vivanet.planos_venda WHERE pop_id = 100072;
DELETE FROM vivanet.pops_venda   WHERE pop_id = 100072;

INSERT INTO vivanet.cobertura (pop_id, cidade, bairro) VALUES
  (22, 'São Gonçalo', 'Tribobó'),
  (22, 'São Gonçalo', 'Lacomba'),
  (22, 'São Gonçalo', 'Nova Grécia')
ON CONFLICT DO NOTHING;

INSERT INTO vivanet.pops_venda (pop_id, vencimentos, taxa_instalacao) VALUES
  (22, '{5,10,15,20}', 160.00)
ON CONFLICT DO NOTHING;

INSERT INTO vivanet.planos_venda (pop_id, nome, valor, sgp_plano_id) VALUES
  (22, '350 Mega', 120.00, 101327)
ON CONFLICT DO NOTHING;
