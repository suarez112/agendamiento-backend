-- 1. Planes nuevos: Emprendedor (1 persona), Equipo (2 a 5) y Pro (6 a 10).
--    Cada empresa pasa al plan que corresponde a su equipo activo (en la prueba, al mayor entre el
--    equipo activo y el número de empleados del registro). No se borra a nadie.
ALTER TABLE empresas DROP CONSTRAINT empresas_plan_equipo_valido;
ALTER TABLE empresas ALTER COLUMN plan_equipo TYPE varchar(20);

UPDATE empresas e
SET plan_equipo = CASE
                    WHEN n.personas <= 1 THEN 'emprendedor'
                    WHEN n.personas <= 5 THEN 'equipo'
                    ELSE 'pro'
                  END
FROM (
  SELECT e2.id,
         GREATEST(
           (SELECT count(*) FROM barberos b WHERE b.empresa_id = e2.id AND b.activo),
           CASE WHEN e2.estado_suscripcion = 'trial' THEN COALESCE(e2.numero_empleados, 0) ELSE 0 END
         ) AS personas
  FROM empresas e2
) n
WHERE n.id = e.id;

ALTER TABLE empresas
  ADD CONSTRAINT empresas_plan_equipo_valido CHECK (plan_equipo IN ('emprendedor', 'equipo', 'pro'));

-- 2. Historial de ingresos estimados: cada activación pasa al plan nuevo de su negocio y se recalcula
--    con los precios nuevos (mensual; anual = mensual × 12 con 10 % de descuento). Son estimados, no pagos reales.
UPDATE activaciones_plan a
SET plan_equipo = COALESCE(
      (SELECT e.plan_equipo FROM empresas e WHERE e.id = a.empresa_id),
      CASE a.plan_equipo WHEN 'basico' THEN 'emprendedor' ELSE a.plan_equipo END);

UPDATE activaciones_plan
SET precio = CASE plan_equipo || '/' || periodo
               WHEN 'emprendedor/mensual' THEN 30000
               WHEN 'emprendedor/anual' THEN 324000
               WHEN 'equipo/mensual' THEN 60000
               WHEN 'equipo/anual' THEN 648000
               WHEN 'pro/mensual' THEN 100000
               WHEN 'pro/anual' THEN 1080000
             END;

-- 3. La administradora (cuenta de correo) puede atender clientes sin crear otro usuario:
--    su perfil de profesional queda vinculado a su cuenta y no tiene inicio de sesión propio.
ALTER TABLE barberos
  ADD COLUMN usuario_id varchar REFERENCES usuarios (id) ON DELETE SET NULL,
  ALTER COLUMN usuario DROP NOT NULL,
  ALTER COLUMN password_hash DROP NOT NULL;
CREATE UNIQUE INDEX barberos_usuario_id_key ON barberos (usuario_id) WHERE usuario_id IS NOT NULL;

-- 4. PQRS prioritarias: prioridad según el plan del negocio y fecha límite de respuesta
ALTER TABLE pqrs
  ADD COLUMN empresa_id varchar,
  ADD COLUMN plan_equipo varchar(20),
  ADD COLUMN prioridad smallint,
  ADD COLUMN dias_habiles smallint,
  ADD COLUMN fecha_limite timestamptz;

UPDATE pqrs p
SET empresa_id = u.empresa_id
FROM usuarios u
WHERE u.id = p.usuario_id;

UPDATE pqrs p
SET plan_equipo = COALESCE((SELECT e.plan_equipo FROM empresas e WHERE e.id = p.empresa_id), 'emprendedor');

UPDATE pqrs
SET prioridad = CASE plan_equipo WHEN 'pro' THEN 1 WHEN 'equipo' THEN 2 ELSE 3 END,
    dias_habiles = CASE plan_equipo WHEN 'pro' THEN 1 WHEN 'equipo' THEN 2 ELSE 3 END;

-- Las anteriores no guardaron plazo: se calcula con días corridos (más corto que con hábiles)
UPDATE pqrs SET fecha_limite = creado_en + dias_habiles * interval '1 day';

ALTER TABLE pqrs
  ALTER COLUMN plan_equipo SET NOT NULL,
  ALTER COLUMN prioridad SET NOT NULL,
  ALTER COLUMN dias_habiles SET NOT NULL,
  ALTER COLUMN fecha_limite SET NOT NULL,
  ADD CONSTRAINT pqrs_prioridad_valida CHECK (prioridad BETWEEN 1 AND 3);

CREATE INDEX pqrs_prioridad_idx ON pqrs (prioridad, fecha_limite) WHERE estado IN ('recibida', 'en_proceso');
