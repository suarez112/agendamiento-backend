-- Registro de empresas: perfil del negocio, periodo de prueba y roles de usuario.
-- Solo agrega columnas, una tabla y restricciones; los datos actuales no cambian.
-- La hora de apertura y cierre reutiliza empresas.horario_apertura / horario_cierre
-- y la fecha de creación reutiliza empresas.created_at (ya existen).

-- 1. Perfil del negocio. Las columnas admiten NULL porque las empresas actuales
--    aún no tienen estos datos; el endpoint de registro debe exigirlos.
ALTER TABLE empresas
  ADD COLUMN categoria varchar(60),
  ADD COLUMN nit varchar(20),
  ADD COLUMN telefono varchar(20),
  ADD COLUMN correo varchar(254),
  ADD COLUMN direccion varchar(200),
  ADD COLUMN ciudad varchar(100),
  -- Días de atención: 0 = domingo ... 6 = sábado (igual que bloqueos.dia_semana)
  ADD COLUMN dias_atencion smallint[],
  ADD COLUMN nombre_administradora varchar(120),
  ADD COLUMN numero_empleados integer,
  ADD COLUMN logo_url varchar(2048),
  ADD COLUMN trial_ends_at timestamptz,
  -- Las empresas actuales ya operan, así que quedan 'activa';
  -- las nuevas empiezan en 'trial' (el valor por defecto cambia justo abajo).
  ADD COLUMN estado_suscripcion varchar(20) NOT NULL DEFAULT 'activa';

ALTER TABLE empresas ALTER COLUMN estado_suscripcion SET DEFAULT 'trial';

ALTER TABLE empresas
  ADD CONSTRAINT empresas_estado_suscripcion_valido
    CHECK (estado_suscripcion IN ('trial', 'activa', 'vencida', 'cancelada')),
  ADD CONSTRAINT empresas_dias_atencion_validos
    CHECK (
      dias_atencion IS NULL
      OR (cardinality(dias_atencion) BETWEEN 1 AND 7
          AND dias_atencion <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]
          AND array_position(dias_atencion, NULL) IS NULL)
    ),
  ADD CONSTRAINT empresas_numero_empleados_valido
    CHECK (numero_empleados IS NULL OR numero_empleados BETWEEN 1 AND 10000),
  ADD CONSTRAINT empresas_correo_valido
    CHECK (correo IS NULL OR correo ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ADD CONSTRAINT empresas_logo_url_valida
    CHECK (logo_url IS NULL OR logo_url ~ '^https?://');

-- El NIT es opcional, pero dos empresas no pueden tener el mismo
CREATE UNIQUE INDEX empresas_nit_key ON empresas (nit) WHERE nit IS NOT NULL;

-- Buscar pruebas próximas a vencer
CREATE INDEX empresas_trial_idx ON empresas (trial_ends_at) WHERE estado_suscripcion = 'trial';

-- 2. Cuentas de usuario con rol. Un admin pertenece a exactamente una empresa;
--    un cliente no tiene empresa. El personal actual (barberos) no cambia.
CREATE TABLE usuarios (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
  correo varchar(254) NOT NULL,
  password_hash varchar NOT NULL,
  rol varchar(10) NOT NULL,
  empresa_id varchar REFERENCES empresas (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usuarios_rol_valido CHECK (rol IN ('admin', 'cliente')),
  CONSTRAINT usuarios_empresa_segun_rol CHECK ((rol = 'admin') = (empresa_id IS NOT NULL)),
  CONSTRAINT usuarios_correo_valido CHECK (correo ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- El correo no distingue mayúsculas: "Ana@x.com" y "ana@x.com" son la misma cuenta
CREATE UNIQUE INDEX usuarios_correo_lower_key ON usuarios (lower(correo));
CREATE INDEX usuarios_empresa_idx ON usuarios (empresa_id) WHERE empresa_id IS NOT NULL;
