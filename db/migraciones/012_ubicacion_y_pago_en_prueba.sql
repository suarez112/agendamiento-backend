-- 1. Ubicación del negocio en el mapa (opcional): latitud y longitud, siempre juntas.
--    Seis decimales ≈ 11 cm, más que suficiente para un local.
ALTER TABLE empresas
  ADD COLUMN latitud numeric(8, 6),
  ADD COLUMN longitud numeric(9, 6),
  ADD CONSTRAINT empresas_latitud_valida CHECK (latitud IS NULL OR latitud BETWEEN -90 AND 90),
  ADD CONSTRAINT empresas_longitud_valida CHECK (longitud IS NULL OR longitud BETWEEN -180 AND 180),
  ADD CONSTRAINT empresas_coordenadas_juntas CHECK ((latitud IS NULL) = (longitud IS NULL));

-- 2. Pago durante la prueba: el plan empieza a contar desde el fin de la prueba.
--    Se guardan los días de prueba que quedaban al pagar y se sumaron al plan
--    (NULL = el plan no se activó durante una prueba).
ALTER TABLE empresas
  ADD COLUMN dias_prueba_sumados integer,
  ADD CONSTRAINT empresas_dias_prueba_sumados_validos
    CHECK (dias_prueba_sumados IS NULL OR dias_prueba_sumados >= 0);
