-- Gestión del negocio: la cuenta de administrador usa la agenda, y el equipo,
-- los servicios, los productos y los bloqueos se administran desde la API.
-- Solo agrega columnas, restricciones e índices; los datos actuales no cambian
-- (todo el equipo y todos los servicios quedan activos).

-- 1. Quién completó o canceló una cita cuando fue la cuenta del administrador
--    (tabla usuarios) y no un barbero. Nunca se llenan las dos columnas a la vez.
ALTER TABLE citas
  ADD COLUMN completada_por_usuario varchar REFERENCES usuarios (id) ON DELETE SET NULL,
  ADD COLUMN cancelada_por_usuario varchar REFERENCES usuarios (id) ON DELETE SET NULL,
  ADD CONSTRAINT citas_completada_por_uno
    CHECK (completada_por IS NULL OR completada_por_usuario IS NULL),
  ADD CONSTRAINT citas_cancelada_por_uno
    CHECK (cancelada_por IS NULL OR cancelada_por_usuario IS NULL);

-- 2. Borrado lógico del equipo y de los servicios: sus citas pasadas siguen
--    mostrando quién atendió y qué servicio fue, y la cartera no cambia.
ALTER TABLE barberos ADD COLUMN activo boolean NOT NULL DEFAULT true;
ALTER TABLE servicios ADD COLUMN activo boolean NOT NULL DEFAULT true;

-- Un usuario de inicio de sesión solo debe ser único entre el equipo activo,
-- para poder reutilizar el de alguien que ya no trabaja en el negocio.
-- Sigue sin distinguir mayúsculas ("Jhon" = "jhon").
ALTER TABLE barberos DROP CONSTRAINT IF EXISTS barberos_usuario_key;
DROP INDEX IF EXISTS barberos_usuario_lower_key;
CREATE UNIQUE INDEX barberos_usuario_activo_key ON barberos (lower(usuario)) WHERE activo;

-- 3. Productos y bloqueos creados desde la API
ALTER TABLE productos
  ALTER COLUMN id SET DEFAULT gen_random_uuid()::text,
  ADD COLUMN descripcion varchar(500);
CREATE INDEX productos_empresa_idx ON productos (empresa_id);

ALTER TABLE bloqueos ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
CREATE INDEX bloqueos_barbero_idx ON bloqueos (barbero_id);

ALTER TABLE lista_negra ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

-- 4. Índices para el historial de clientes y la cartera
CREATE INDEX citas_cliente_idx ON citas (cliente_id);
CREATE INDEX citas_empresa_estado_fecha_idx ON citas (empresa_id, estado, fecha);
