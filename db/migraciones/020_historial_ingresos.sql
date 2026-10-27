-- Historial de activaciones de plan, para estimar los ingresos de la plataforma.
-- Solo agrega una tabla: los datos actuales no cambian.
-- No hay pagos reales todavía: el precio es el que tenía el plan en el momento (estimado).
-- Sin llave foránea a propósito (como actividad_superadmin): el historial se conserva aunque
-- el negocio cambie, y copia su nombre y código de ese momento.

CREATE TABLE activaciones_plan (
  id bigserial PRIMARY KEY,
  empresa_id varchar NOT NULL,
  empresa_codigo varchar,
  empresa_nombre varchar,
  plan_equipo varchar(20) NOT NULL,
  periodo varchar(10) NOT NULL,
  precio numeric(12, 2) NOT NULL,
  moneda varchar(3) NOT NULL DEFAULT 'COP',
  -- Día de la activación en hora de Colombia
  fecha date NOT NULL,
  -- panel: superadmin | comando: dev:activar-plan | historico: copiada de lo que ya existía
  origen varchar(12) NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activaciones_plan_periodo_valido CHECK (periodo IN ('mensual', 'anual')),
  CONSTRAINT activaciones_plan_origen_valido CHECK (origen IN ('panel', 'comando', 'historico')),
  CONSTRAINT activaciones_plan_precio_valido CHECK (precio >= 0)
);

CREATE INDEX activaciones_plan_fecha_idx ON activaciones_plan (fecha);
CREATE INDEX activaciones_plan_empresa_idx ON activaciones_plan (empresa_id, fecha DESC);

-- Llena el historial con lo que ya existe: la última activación de cada negocio que alguna vez
-- pagó (fecha_pago y plan_suscripcion). Las anteriores no se guardaron, así que no se pueden
-- recuperar. Precios de hoy de src/config/planes.ts (de ejemplo).
INSERT INTO activaciones_plan (empresa_id, empresa_codigo, empresa_nombre, plan_equipo, periodo, precio, fecha, origen)
SELECT e.id, e.codigo_acceso, e.nombre, e.plan_equipo, e.plan_suscripcion,
       CASE e.plan_equipo || '/' || e.plan_suscripcion
         WHEN 'basico/mensual' THEN 30000
         WHEN 'basico/anual' THEN 300000
         WHEN 'equipo/mensual' THEN 50000
         WHEN 'equipo/anual' THEN 500000
         WHEN 'pro/mensual' THEN 80000
         WHEN 'pro/anual' THEN 800000
       END,
       e.fecha_pago, 'historico'
FROM empresas e
WHERE e.fecha_pago IS NOT NULL
  AND e.plan_suscripcion IN ('mensual', 'anual')
  AND e.plan_equipo IN ('basico', 'equipo', 'pro');
