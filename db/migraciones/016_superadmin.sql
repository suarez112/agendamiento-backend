-- Panel del superadministrador (dueño de la plataforma).
-- Solo agrega columnas y tablas: los datos actuales no cambian.

-- 1. Suspensión de un negocio. Un negocio suspendido se comporta como uno vencido,
--    pero conserva su plan y sus fechas, así que reactivarlo lo deja como estaba.
ALTER TABLE empresas
  ADD COLUMN suspendida_en timestamptz,
  ADD COLUMN suspension_motivo varchar(300),
  ADD CONSTRAINT empresas_suspension_coherente CHECK ((suspendida_en IS NULL) = (suspension_motivo IS NULL));

-- 2. Superadministradores. Tabla aparte de usuarios: ningún login de la app (cuentas,
--    login único, recuperar contraseña) puede llegar a ellos. Solo se crean con
--    el comando npm run dev:crear-superadmin.
--    totp_secreto: clave de la verificación en dos pasos, cifrada (nunca en claro).
--    totp_ultimo_paso: último código usado, para que no se pueda reutilizar.
CREATE TABLE superadmins (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
  correo varchar(254) NOT NULL,
  password_hash varchar NOT NULL,
  totp_secreto text NOT NULL,
  totp_ultimo_paso bigint,
  version_sesion integer NOT NULL DEFAULT 0,
  intentos_fallidos integer NOT NULL DEFAULT 0,
  bloqueado_hasta timestamptz,
  creado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT superadmins_correo_valido CHECK (correo ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

CREATE UNIQUE INDEX superadmins_correo_lower_key ON superadmins (lower(correo));

-- 3. Registro de actividad del superadmin. Solo se agregan filas: un disparador
--    rechaza cualquier UPDATE, DELETE o TRUNCATE. No hay llaves foráneas a propósito
--    (una acción en cascada intentaría modificar el registro): el correo y los datos
--    del negocio quedan copiados tal como estaban en ese momento.
CREATE TABLE actividad_superadmin (
  id bigserial PRIMARY KEY,
  superadmin_id varchar NOT NULL,
  superadmin_correo varchar(254) NOT NULL,
  accion varchar(40) NOT NULL,
  empresa_id varchar,
  empresa_codigo varchar,
  empresa_nombre varchar,
  referencia varchar(40),
  detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  motivo varchar(300),
  creado_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX actividad_superadmin_fecha_idx ON actividad_superadmin (creado_en DESC, id DESC);
CREATE INDEX actividad_superadmin_empresa_idx ON actividad_superadmin (empresa_id, creado_en DESC) WHERE empresa_id IS NOT NULL;

CREATE FUNCTION actividad_superadmin_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'El registro de actividad del superadmin no se puede modificar ni borrar';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER actividad_superadmin_sin_cambios
  BEFORE UPDATE OR DELETE ON actividad_superadmin
  FOR EACH ROW EXECUTE FUNCTION actividad_superadmin_inmutable();

CREATE TRIGGER actividad_superadmin_sin_truncate
  BEFORE TRUNCATE ON actividad_superadmin
  FOR EACH STATEMENT EXECUTE FUNCTION actividad_superadmin_inmutable();
