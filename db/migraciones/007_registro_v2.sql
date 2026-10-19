-- Registro de empresa v2, horario por día, usuario de la administradora y
-- bloqueos de un solo día.
-- Los datos que se conservan se copian antes de quitar las columnas viejas.
-- Si algún dato actual viola una regla nueva, la migración falla completa y no cambia nada.

-- 1. Horario de atención por día. Un día sin fila está cerrado.
--    Reemplaza empresas.dias_atencion, horario_apertura y horario_cierre.
CREATE TABLE horarios_empresa (
  empresa_id varchar NOT NULL REFERENCES empresas (id) ON DELETE CASCADE,
  -- 0 = domingo ... 6 = sábado (igual que bloqueos.dia_semana)
  dia_semana smallint NOT NULL,
  hora_apertura time NOT NULL,
  hora_cierre time NOT NULL,
  PRIMARY KEY (empresa_id, dia_semana),
  CONSTRAINT horarios_empresa_dia_valido CHECK (dia_semana BETWEEN 0 AND 6),
  CONSTRAINT horarios_empresa_horario_valido CHECK (hora_cierre > hora_apertura)
);

-- Cada día de atención conserva el horario que tenía la empresa. Las empresas
-- sin días guardados atendían todos los días, así que quedan abiertas los 7.
INSERT INTO horarios_empresa (empresa_id, dia_semana, hora_apertura, hora_cierre)
SELECT e.id, dia, e.horario_apertura, e.horario_cierre
FROM empresas e
CROSS JOIN LATERAL unnest(COALESCE(e.dias_atencion, ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[])) AS dia;

ALTER TABLE empresas
  DROP COLUMN dias_atencion,
  DROP COLUMN horario_apertura,
  DROP COLUMN horario_cierre;

DROP FUNCTION sin_repetidos(anyarray);

-- 2. Sin NIT, teléfono ni correo de contacto del negocio.
--    El correo de inicio de sesión de la administradora sigue en usuarios.correo.
DROP TRIGGER empresas_normalizar_nit ON empresas;
DROP FUNCTION empresas_normalizar_nit();
ALTER TABLE empresas
  DROP COLUMN nit,
  DROP COLUMN telefono,
  DROP COLUMN correo;

-- 3. Departamento de Colombia (la ciudad ya existe en empresas.ciudad).
--    Las empresas actuales quedan sin departamento hasta que lo completen.
ALTER TABLE empresas ADD COLUMN departamento varchar(60);

-- 4. Número de empleados entre 1 y 10
ALTER TABLE empresas
  DROP CONSTRAINT empresas_numero_empleados_valido,
  ADD CONSTRAINT empresas_numero_empleados_valido
    CHECK (numero_empleados IS NULL OR numero_empleados BETWEEN 1 AND 10);

-- 5. Código del negocio: lo escribe la administradora. Solo letras y números,
--    máximo 10, guardado en mayúsculas (así "abc" y "ABC" son el mismo código).
--    Los códigos actuales ya cumplen la regla y no cambian.
ALTER TABLE empresas
  ADD CONSTRAINT empresas_codigo_acceso_valido CHECK (codigo_acceso ~ '^[A-Z0-9]{1,10}$');

-- 6. Usuario de inicio de sesión de la administradora (los clientes no tienen)
ALTER TABLE usuarios ADD COLUMN usuario varchar(20);

-- Las administradoras actuales reciben un usuario a partir de su correo: lo que va
-- antes de la @, en minúsculas, solo letras, números, punto y guion bajo, máximo 20.
-- Si ya existe (en otra cuenta o en el equipo), se le agrega un número: ana2, ana3...
DO $$
DECLARE
  cuenta record;
  base text;
  candidato text;
  n int;
BEGIN
  FOR cuenta IN SELECT id, correo FROM usuarios WHERE rol = 'admin' ORDER BY created_at, id LOOP
    base := left(regexp_replace(lower(split_part(cuenta.correo, '@', 1)), '[^a-z0-9._]', '', 'g'), 20);
    IF length(base) < 4 THEN
      base := rpad(base, 4, '0');
    END IF;
    candidato := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM usuarios WHERE lower(usuario) = candidato)
       OR EXISTS (SELECT 1 FROM barberos WHERE activo AND lower(usuario) = candidato) LOOP
      n := n + 1;
      candidato := left(base, 20 - length(n::text)) || n;
    END LOOP;
    UPDATE usuarios SET usuario = candidato WHERE id = cuenta.id;
  END LOOP;
END;
$$;

ALTER TABLE usuarios
  ADD CONSTRAINT usuarios_usuario_valido CHECK (usuario IS NULL OR usuario ~ '^[A-Za-z0-9._]{4,20}$'),
  ADD CONSTRAINT usuarios_admin_con_usuario CHECK (rol <> 'admin' OR usuario IS NOT NULL);

-- El usuario no distingue mayúsculas: "Ana.P" y "ana.p" son el mismo
CREATE UNIQUE INDEX usuarios_usuario_lower_key ON usuarios (lower(usuario)) WHERE usuario IS NOT NULL;

-- Un usuario de inicio de sesión no puede repetirse entre administradoras (usuarios)
-- y el equipo activo (barberos). Un índice único no puede abarcar dos tablas, así
-- que lo revisa este trigger. El candado por nombre hace que dos registros
-- simultáneos con el mismo usuario se esperen y el segundo vea al primero.
CREATE FUNCTION verificar_usuario_login_unico() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  repetido boolean;
BEGIN
  IF NEW.usuario IS NULL OR (TG_TABLE_NAME = 'barberos' AND NOT NEW.activo) THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('usuario_login:' || lower(NEW.usuario)));
  IF TG_TABLE_NAME = 'barberos' THEN
    SELECT EXISTS (SELECT 1 FROM usuarios WHERE lower(usuario) = lower(NEW.usuario)) INTO repetido;
  ELSE
    SELECT EXISTS (SELECT 1 FROM barberos WHERE activo AND lower(usuario) = lower(NEW.usuario)) INTO repetido;
  END IF;
  IF repetido THEN
    RAISE EXCEPTION 'El usuario % ya está en uso', NEW.usuario
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'usuario_login_unico';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER usuarios_usuario_login_unico
  BEFORE INSERT OR UPDATE OF usuario ON usuarios
  FOR EACH ROW EXECUTE FUNCTION verificar_usuario_login_unico();

CREATE TRIGGER barberos_usuario_login_unico
  BEFORE INSERT OR UPDATE OF usuario, activo ON barberos
  FOR EACH ROW EXECUTE FUNCTION verificar_usuario_login_unico();

-- 7. Bloqueos: semanales (es_repetitivo + dia_semana) o de una fecha
--    (fecha_especifica). Un día completo se guarda de 00:00 a 24:00.
UPDATE bloqueos SET es_repetitivo = false WHERE es_repetitivo IS NULL;
ALTER TABLE bloqueos
  ALTER COLUMN es_repetitivo SET NOT NULL,
  ADD CONSTRAINT bloqueos_tipo_valido CHECK (
    (es_repetitivo AND dia_semana IS NOT NULL AND fecha_especifica IS NULL)
    OR (NOT es_repetitivo AND fecha_especifica IS NOT NULL AND dia_semana IS NULL)
  );
