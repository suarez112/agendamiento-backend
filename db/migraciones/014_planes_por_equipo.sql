-- Planes por tamaño de equipo: basico (hasta 3), equipo (hasta 5) y pro (hasta 10).
-- plan_suscripcion sigue siendo el periodo (mensual o anual); plan_equipo es el
-- tamaño. El cupo de cada plan y los precios están en src/config/planes.ts.
-- Las empresas creadas sin plan (ej. en pruebas) quedan en pro, el cupo de antes (10).
ALTER TABLE empresas
  ADD COLUMN plan_equipo varchar(10) NOT NULL DEFAULT 'pro',
  ADD CONSTRAINT empresas_plan_equipo_valido CHECK (plan_equipo IN ('basico', 'equipo', 'pro'));

-- Empresas existentes: el plan más pequeño que alcanza para su equipo activo actual
-- (no se borra a nadie). Las que están en prueba usan además el número de empleados
-- del registro, si es mayor, para no quitarles el cupo con el que se registraron.
UPDATE empresas e
SET plan_equipo = CASE
                    WHEN n.personas <= 3 THEN 'basico'
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
