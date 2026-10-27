-- 1. Precisión del GPS (opcional, en metros) de la ubicación del negocio.
--    Solo tiene sentido con coordenadas.
ALTER TABLE empresas
  ADD COLUMN precision_ubicacion numeric(7, 1),
  ADD CONSTRAINT empresas_precision_ubicacion_valida
    CHECK (precision_ubicacion IS NULL OR (precision_ubicacion > 0 AND precision_ubicacion <= 100000)),
  ADD CONSTRAINT empresas_precision_con_coordenadas
    CHECK (precision_ubicacion IS NULL OR latitud IS NOT NULL);

-- 2. Versión de las sesiones de cada cuenta. Va dentro del token; al cambiar la
--    contraseña sube y los tokens anteriores dejan de servir.
ALTER TABLE usuarios
  ADD COLUMN version_sesion integer NOT NULL DEFAULT 0;

-- 3. Códigos para recuperar la contraseña (administradoras y clientes con cuenta).
--    Se guarda solo el HMAC del código, nunca el código. De un solo uso, vence en
--    15 minutos y se bloquea tras 5 intentos fallidos.
CREATE TABLE codigos_recuperacion (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
  usuario_id varchar NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  codigo_hash varchar(64) NOT NULL,
  vence_en timestamptz NOT NULL,
  intentos smallint NOT NULL DEFAULT 0,
  usado_en timestamptz,
  creado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT codigos_recuperacion_intentos_validos CHECK (intentos BETWEEN 0 AND 5)
);

CREATE INDEX codigos_recuperacion_usuario_idx ON codigos_recuperacion (usuario_id, creado_en DESC);
