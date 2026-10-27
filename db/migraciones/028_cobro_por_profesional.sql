-- Cobro por profesional. Se cobra por cada integrante activo que atiende clientes
-- (barberos.activo AND atiende_clientes). El nivel (emprendedor | equipo | pro) sale de ese número.
-- No se borra a nadie: solo se recalculan niveles y se agregan columnas y una tabla.

-- Profesionales cubiertos por lo ya pagado en el periodo actual: agregar uno por encima de este número
-- genera un cargo proporcional; reemplazar a alguien (sin pasar de este número) no cuesta.
ALTER TABLE empresas ADD COLUMN profesionales_pagados integer NOT NULL DEFAULT 0;
ALTER TABLE empresas ADD CONSTRAINT empresas_profesionales_pagados_valido CHECK (profesionales_pagados >= 0);

-- Migra las empresas existentes: nivel según los profesionales cobrados (en la prueba, también el
-- número de empleados del registro si era mayor) y lo pagado según el equipo actual.
UPDATE empresas e
SET plan_equipo = CASE WHEN x.n <= 1 THEN 'emprendedor' WHEN x.n <= 5 THEN 'equipo' ELSE 'pro' END,
    profesionales_pagados = CASE WHEN e.estado_suscripcion = 'activa' THEN GREATEST(x.cobrados, 1) ELSE 0 END
FROM (
  SELECT e2.id,
         c.cobrados,
         GREATEST(c.cobrados, CASE WHEN e2.estado_suscripcion = 'trial' THEN e2.numero_empleados ELSE 0 END) AS n
  FROM empresas e2
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS cobrados FROM barberos b
    WHERE b.empresa_id = e2.id AND b.activo AND b.atiende_clientes
  ) c
) x
WHERE x.id = e.id;

-- Cargos por agregar profesionales a mitad de un periodo. Todavía no hay pagos reales: nacen 'pendiente' y
-- un comando los marca 'pagado'. Sin llave foránea a propósito (como activaciones_plan): se conservan
-- aunque el negocio cambie, y copian su código y nombre de ese momento.
CREATE TABLE cargos (
  id bigserial PRIMARY KEY,
  empresa_id varchar NOT NULL,
  empresa_codigo varchar,
  empresa_nombre varchar,
  barbero_id varchar,
  tipo varchar(30) NOT NULL DEFAULT 'profesional_adicional',
  concepto varchar(200) NOT NULL,
  periodo varchar(10) NOT NULL,
  -- Días que faltaban del periodo y días del periodo completo (de ahí sale el proporcional)
  dias_restantes integer NOT NULL,
  dias_periodo integer NOT NULL,
  monto numeric(12, 2) NOT NULL,
  moneda varchar(3) NOT NULL DEFAULT 'COP',
  estado varchar(10) NOT NULL DEFAULT 'pendiente',
  -- Día del cargo y del pago, en la zona de la plataforma
  fecha date NOT NULL,
  fecha_pago date,
  -- comando: dev:cargos | activacion: se pagó junto con una activación de plan (ya está en su precio) | panel
  pagado_por varchar(12),
  creado_en timestamptz NOT NULL DEFAULT now(),
  pagado_en timestamptz,
  CONSTRAINT cargos_periodo_valido CHECK (periodo IN ('mensual', 'anual')),
  CONSTRAINT cargos_estado_valido CHECK (estado IN ('pendiente', 'pagado')),
  CONSTRAINT cargos_pagado_por_valido CHECK (pagado_por IS NULL OR pagado_por IN ('comando', 'activacion', 'panel')),
  CONSTRAINT cargos_monto_valido CHECK (monto >= 0),
  CONSTRAINT cargos_pago_coherente CHECK ((estado = 'pagado') = (pagado_en IS NOT NULL))
);
CREATE INDEX cargos_empresa_idx ON cargos (empresa_id, fecha DESC);
CREATE INDEX cargos_estado_idx ON cargos (estado, fecha);

-- Historial de ingresos: cuántos profesionales cubría cada activación. El precio (bruto) se recalcula
-- con el modelo nuevo según los profesionales actuales de cada negocio (son estimados, no pagos).
ALTER TABLE activaciones_plan ADD COLUMN profesionales integer NOT NULL DEFAULT 1;

UPDATE activaciones_plan a
SET profesionales = x.n,
    precio = CASE a.periodo
               WHEN 'mensual' THEN x.mensual
               ELSE round(x.mensual * 12 * 0.9)
             END
FROM (
  SELECT a2.id,
         GREATEST(COALESCE(c.cobrados, 0), 1) AS n,
         35000 + 25000 * (GREATEST(COALESCE(c.cobrados, 0), 1) - 1) AS mensual
  FROM activaciones_plan a2
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS cobrados FROM barberos b
    WHERE b.empresa_id = a2.empresa_id AND b.activo AND b.atiende_clientes
  ) c ON true
) x
WHERE x.id = a.id;
