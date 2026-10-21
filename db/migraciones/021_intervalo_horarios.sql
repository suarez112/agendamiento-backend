-- Horarios disponibles según la duración del servicio.
-- 1. Los servicios duran un múltiplo de 10 minutos, de 10 a 150 (2 h 30).
-- 2. Cada negocio elige cada cuántos minutos pueden agendar sus clientes.

-- Los servicios que ya existían se ajustan al múltiplo de 10 más cercano hacia arriba
-- (45 min pasa a 50), dentro de 10 a 150. Las citas ya agendadas guardan su propia
-- hora de inicio y de fin, así que no cambian.
UPDATE servicios
SET duracion_min = GREATEST(10, LEAST(150, CEIL(duracion_min / 10.0)::int * 10))
WHERE duracion_min % 10 <> 0 OR duracion_min NOT BETWEEN 10 AND 150;

ALTER TABLE servicios
  DROP CONSTRAINT servicios_duracion_valida,
  ADD CONSTRAINT servicios_duracion_valida CHECK (duracion_min BETWEEN 10 AND 150 AND duracion_min % 10 = 0);

-- Intervalo de horarios del negocio (por defecto 30 minutos: 10:00, 10:30, 11:00…)
ALTER TABLE empresas
  ADD COLUMN intervalo_minutos smallint NOT NULL DEFAULT 30,
  ADD CONSTRAINT empresas_intervalo_valido CHECK (intervalo_minutos IN (10, 20, 30, 40, 50, 60));
