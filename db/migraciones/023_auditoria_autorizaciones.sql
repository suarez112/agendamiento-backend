-- Auditoría de las autorizaciones de datos (Ley 1581): una fila por cada aceptación, que nunca se modifica ni se borra.
-- Sin llaves foráneas a propósito: la prueba debe sobrevivir aunque la cuenta, el negocio o la cita se borren
-- (una llave con ON DELETE CASCADE intentaría borrar filas y el trigger lo rechazaría).
-- aceptado_en se guarda en UTC (timestamptz); la API lo devuelve en ISO 8601 con la zona de Colombia.

CREATE TABLE auditoria_autorizaciones (
  id bigserial PRIMARY KEY,
  -- Quién aceptó: una cuenta (usuario_id), alguien del equipo (barbero_id) o un invitado (telefono y/o correo)
  usuario_id varchar,
  barbero_id varchar,
  correo varchar(254),
  telefono varchar(30),
  indicativo varchar(4),
  empresa_id varchar,
  cita_id varchar,
  canal varchar(20) NOT NULL,
  version_politica varchar(30) NOT NULL,
  version_terminos varchar(30) NOT NULL,
  -- Salen solo de la petición HTTP en el servidor, nunca del cuerpo que envía la app
  ip varchar(45),
  user_agent varchar(500),
  aceptado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auditoria_autorizaciones_canal_valido
    CHECK (canal IN ('registro_empresa', 'registro_cliente', 'reserva_invitado', 'nueva_version')),
  CONSTRAINT auditoria_autorizaciones_con_titular
    CHECK (usuario_id IS NOT NULL OR barbero_id IS NOT NULL OR telefono IS NOT NULL OR correo IS NOT NULL)
);

CREATE INDEX auditoria_autorizaciones_usuario_idx ON auditoria_autorizaciones (usuario_id, aceptado_en DESC)
  WHERE usuario_id IS NOT NULL;
CREATE INDEX auditoria_autorizaciones_barbero_idx ON auditoria_autorizaciones (barbero_id, aceptado_en DESC)
  WHERE barbero_id IS NOT NULL;

-- Solo inserción: cualquier UPDATE, DELETE o TRUNCATE se rechaza, también para el usuario postgres
CREATE FUNCTION auditoria_autorizaciones_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'La auditoría de autorizaciones es solo de inserción: no se puede modificar ni borrar';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auditoria_autorizaciones_sin_cambios
  BEFORE UPDATE OR DELETE ON auditoria_autorizaciones
  FOR EACH ROW EXECUTE FUNCTION auditoria_autorizaciones_inmutable();

CREATE TRIGGER auditoria_autorizaciones_sin_truncate
  BEFORE TRUNCATE ON auditoria_autorizaciones
  FOR EACH STATEMENT EXECUTE FUNCTION auditoria_autorizaciones_inmutable();

-- Copia las aceptaciones que ya existían (sin IP ni User-Agent: entonces no se guardaban)
INSERT INTO auditoria_autorizaciones
  (usuario_id, telefono, indicativo, empresa_id, cita_id, canal, version_politica, version_terminos, aceptado_en)
SELECT usuario_id, telefono, indicativo, empresa_id, cita_id,
       CASE origen
         WHEN 'registro_empresa' THEN 'registro_empresa'
         WHEN 'registro_cliente' THEN 'registro_cliente'
         WHEN 'reserva' THEN CASE WHEN usuario_id IS NULL THEN 'reserva_invitado' ELSE 'nueva_version' END
       END,
       version_politica, version_terminos, aceptado_en
FROM autorizaciones_datos
ORDER BY aceptado_en;
