-- 1. categorias_negocio: categorías que puede elegir un negocio al registrarse. Solo el
--    superadmin las crea, edita o desactiva. empresas.categoria sigue guardando el nombre
--    (los negocios que ya existían no cambian).
-- 2. notificaciones: centro de notificaciones dentro de la app. Cada una es de una cuenta
--    (usuario_id: administradora o cliente) o de un integrante del equipo (barbero_id),
--    nunca de los dos, y se borra con su dueño. La cita relacionada, si se borra, solo se desvincula.

CREATE TABLE categorias_negocio (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
  nombre varchar(60) NOT NULL,
  activa boolean NOT NULL DEFAULT true,
  creada_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categorias_negocio_nombre_no_vacio CHECK (btrim(nombre) <> '')
);

CREATE UNIQUE INDEX categorias_negocio_nombre_key ON categorias_negocio (lower(nombre));

INSERT INTO categorias_negocio (nombre) VALUES ('Barbería'), ('Peluquería'), ('Salón de belleza');

CREATE TABLE notificaciones (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
  usuario_id varchar REFERENCES usuarios (id) ON DELETE CASCADE,
  barbero_id varchar REFERENCES barberos (id) ON DELETE CASCADE,
  tipo varchar(40) NOT NULL,
  titulo varchar(100) NOT NULL,
  texto varchar(400) NOT NULL,
  cita_id varchar REFERENCES citas (id) ON DELETE SET NULL,
  leida_en timestamptz,
  creada_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notificaciones_un_dueno CHECK ((usuario_id IS NULL) <> (barbero_id IS NULL))
);

CREATE INDEX notificaciones_usuario_idx ON notificaciones (usuario_id, creada_en DESC) WHERE usuario_id IS NOT NULL;
CREATE INDEX notificaciones_barbero_idx ON notificaciones (barbero_id, creada_en DESC) WHERE barbero_id IS NOT NULL;
