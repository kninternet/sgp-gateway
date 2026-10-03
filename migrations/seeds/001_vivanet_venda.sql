-- Condições de venda da Viva Net. Idempotente: só insere o que ainda não existe.
INSERT INTO vivanet.cobertura (pop_id, cidade, bairro) VALUES
  (22, 'Rio de Janeiro', 'Pavuna')
ON CONFLICT DO NOTHING;

INSERT INTO vivanet.pops_venda (pop_id, vencimentos, taxa_instalacao) VALUES
  (22, '{5,10,15,20}', 160.00)
ON CONFLICT DO NOTHING;

INSERT INTO vivanet.planos_venda (pop_id, nome, valor, sgp_plano_id) VALUES
  (22, '350 Mega', 120.00, 101327)
ON CONFLICT DO NOTHING;
