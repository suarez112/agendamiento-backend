-- Tanda 3 de la auditoría (M-1, M-4).
-- 1. barberos.version_sesion: igual que usuarios.version_sesion. Sube al cambiar la contraseña del integrante
--    o al cerrar sesión en el servidor (POST /logout) e invalida los tokens anteriores. Los tokens firmados antes de
--    esta migración no traen versión y cuentan como 0, así que siguen sirviendo hasta que la versión suba.
-- 2. intentos_login: contador de inicios de sesión fallidos por cuenta, guardado en la base (sobrevive a un
--    reinicio y se comparte entre instancias). La clave es un hash del correo o usuario (nunca el texto), y se
--    cuenta también para identificadores que no existen, así la respuesta no revela qué cuentas hay.

ALTER TABLE barberos ADD COLUMN version_sesion integer NOT NULL DEFAULT 0;

CREATE TABLE intentos_login (
  clave varchar(120) PRIMARY KEY,
  intentos integer NOT NULL DEFAULT 0,
  primer_intento timestamptz NOT NULL DEFAULT now(),
  -- Cuántas veces seguidas se bloqueó: la espera crece con cada bloqueo
  bloqueos integer NOT NULL DEFAULT 0,
  bloqueado_hasta timestamptz,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intentos_login_valores CHECK (intentos >= 0 AND bloqueos >= 0)
);

-- Para borrar las filas viejas sin recorrer toda la tabla
CREATE INDEX intentos_login_actualizado_idx ON intentos_login (actualizado_en);
