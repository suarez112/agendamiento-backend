-- Zona horaria por negocio y todas las marcas de tiempo en UTC (timestamptz).
--
-- 1. empresas.pais (ISO 3166-1 alfa-2) y empresas.zona_horaria (nombre IANA, ej. America/Bogota).
--    Las empresas que ya existían quedan en Colombia / America/Bogota.
-- 2. Las columnas "timestamp" sin zona (created_at, completada_en, cancelada_en) se guardaban con la hora
--    local del servidor, que era America/Bogota: se convierten a timestamptz interpretándolas en esa zona,
--    así el instante que representan no cambia.
-- 3. Las fechas y horas de una cita (fecha, hora_inicio, hora_fin) y del horario del negocio son la hora de
--    pared del negocio (en su zona); no se tocan.

ALTER TABLE empresas
  ADD COLUMN pais char(2) NOT NULL DEFAULT 'CO',
  ADD COLUMN zona_horaria varchar(64) NOT NULL DEFAULT 'America/Bogota',
  ADD CONSTRAINT empresas_pais_valido CHECK (pais ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT empresas_zona_horaria_valida CHECK (zona_horaria ~ '^[A-Za-z0-9_+/-]{1,64}$');

ALTER TABLE empresas ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'America/Bogota';
ALTER TABLE empresas ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE barberos ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'America/Bogota';
ALTER TABLE barberos ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE bloqueos ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'America/Bogota';
ALTER TABLE bloqueos ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE clientes ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'America/Bogota';
ALTER TABLE clientes ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE lista_negra ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'America/Bogota';
ALTER TABLE lista_negra ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE productos ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'America/Bogota';
ALTER TABLE productos ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE servicios ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'America/Bogota';
ALTER TABLE servicios ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE citas ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'America/Bogota';
ALTER TABLE citas ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE citas ALTER COLUMN completada_en TYPE timestamptz USING completada_en AT TIME ZONE 'America/Bogota';
ALTER TABLE citas ALTER COLUMN cancelada_en TYPE timestamptz USING cancelada_en AT TIME ZONE 'America/Bogota';
