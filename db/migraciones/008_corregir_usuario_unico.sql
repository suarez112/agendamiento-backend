-- Corrige verificar_usuario_login_unico (migración 007): en una cuenta (tabla
-- usuarios) leía NEW.activo, que solo existe en barberos, y el registro fallaba.
-- PL/pgSQL no garantiza que "A AND B" deje de evaluar B cuando A es falso, así que
-- la revisión de activo va en un IF aparte. Los triggers siguen usando esta función.
CREATE OR REPLACE FUNCTION verificar_usuario_login_unico() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  repetido boolean;
BEGIN
  IF NEW.usuario IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'barberos' THEN
    -- Un barbero eliminado ya no ocupa su usuario
    IF NOT NEW.activo THEN
      RETURN NEW;
    END IF;
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
