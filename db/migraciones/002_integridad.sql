-- Reglas de integridad que antes solo existían en el código de la API.
-- Si algún dato actual las viola, la migración falla completa y no cambia nada.

-- Necesaria para combinar "=" (texto) y "&&" (rangos) en una restricción de exclusión
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1. Todo registro pertenece a un negocio
ALTER TABLE barberos
  ALTER COLUMN empresa_id SET NOT NULL,
  ALTER COLUMN es_admin SET NOT NULL,
  ALTER COLUMN porcentaje_ganancia SET NOT NULL;
ALTER TABLE servicios ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE productos ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE clientes
  ALTER COLUMN empresa_id SET NOT NULL,
  ALTER COLUMN total_citas SET NOT NULL;
ALTER TABLE lista_negra ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE bloqueos ALTER COLUMN barbero_id SET NOT NULL;
ALTER TABLE citas
  ALTER COLUMN empresa_id SET NOT NULL,
  ALTER COLUMN barbero_id SET NOT NULL,
  ALTER COLUMN servicio_id SET NOT NULL,
  ALTER COLUMN cliente_id SET NOT NULL,
  ALTER COLUMN estado SET NOT NULL;

-- 2. Valores válidos
ALTER TABLE empresas
  ADD CONSTRAINT empresas_horario_valido CHECK (horario_cierre > horario_apertura);
ALTER TABLE barberos
  ADD CONSTRAINT barberos_porcentaje_valido CHECK (porcentaje_ganancia BETWEEN 0 AND 100);
ALTER TABLE servicios
  ADD CONSTRAINT servicios_duracion_valida CHECK (duracion_min BETWEEN 1 AND 1440),
  ADD CONSTRAINT servicios_precio_valido CHECK (precio >= 0);
ALTER TABLE productos
  ADD CONSTRAINT productos_precio_valido CHECK (precio >= 0);
ALTER TABLE clientes
  ADD CONSTRAINT clientes_total_citas_valido CHECK (total_citas >= 0);
ALTER TABLE bloqueos
  ADD CONSTRAINT bloqueos_horario_valido CHECK (hora_fin > hora_inicio),
  ADD CONSTRAINT bloqueos_dia_valido CHECK (dia_semana IS NULL OR dia_semana BETWEEN 0 AND 6);
ALTER TABLE citas
  ADD CONSTRAINT citas_estado_valido CHECK (estado IN ('CONFIRMADA', 'COMPLETADA', 'CANCELADA')),
  ADD CONSTRAINT citas_horario_valido CHECK (hora_fin > hora_inicio),
  ADD CONSTRAINT citas_precio_valido CHECK (precio >= 0);

-- 3. El inicio de sesión no distingue mayúsculas: "Jhon" y "jhon" son el mismo usuario
CREATE UNIQUE INDEX barberos_usuario_lower_key ON barberos (lower(usuario));

-- 4. Un cliente es único por negocio + indicativo + teléfono (así lo busca la API)
ALTER TABLE clientes DROP CONSTRAINT uq_cliente_empresa_tel;
ALTER TABLE clientes
  ADD CONSTRAINT uq_cliente_empresa_tel UNIQUE (empresa_id, indicativo, telefono);

-- 5. Aislamiento entre negocios: una cita solo puede apuntar a profesionales,
--    servicios y clientes de su mismo negocio
ALTER TABLE barberos ADD CONSTRAINT barberos_empresa_id_id_key UNIQUE (empresa_id, id);
ALTER TABLE servicios ADD CONSTRAINT servicios_empresa_id_id_key UNIQUE (empresa_id, id);
ALTER TABLE clientes ADD CONSTRAINT clientes_empresa_id_id_key UNIQUE (empresa_id, id);

ALTER TABLE citas
  DROP CONSTRAINT citas_barbero_id_fkey,
  DROP CONSTRAINT citas_servicio_id_fkey,
  DROP CONSTRAINT citas_cliente_id_fkey,
  DROP CONSTRAINT citas_completada_por_fkey,
  DROP CONSTRAINT citas_cancelada_por_fkey,
  ADD CONSTRAINT citas_barbero_misma_empresa_fkey
    FOREIGN KEY (empresa_id, barbero_id) REFERENCES barberos (empresa_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT citas_servicio_misma_empresa_fkey
    FOREIGN KEY (empresa_id, servicio_id) REFERENCES servicios (empresa_id, id),
  ADD CONSTRAINT citas_cliente_misma_empresa_fkey
    FOREIGN KEY (empresa_id, cliente_id) REFERENCES clientes (empresa_id, id),
  ADD CONSTRAINT citas_completada_por_misma_empresa_fkey
    FOREIGN KEY (empresa_id, completada_por) REFERENCES barberos (empresa_id, id),
  ADD CONSTRAINT citas_cancelada_por_misma_empresa_fkey
    FOREIGN KEY (empresa_id, cancelada_por) REFERENCES barberos (empresa_id, id);

-- 6. Doble reserva imposible: dos citas activas del mismo profesional no pueden
--    solaparse, aunque lleguen dos solicitudes al mismo tiempo
ALTER TABLE citas
  ADD CONSTRAINT citas_sin_solapamiento EXCLUDE USING gist (
    barbero_id WITH =,
    tsrange(fecha + hora_inicio, fecha + hora_fin) WITH &&
  ) WHERE (estado <> 'CANCELADA');

-- 7. Índices para las consultas frecuentes (agenda y horas ocupadas por negocio)
CREATE INDEX citas_empresa_fecha_idx ON citas (empresa_id, fecha);
