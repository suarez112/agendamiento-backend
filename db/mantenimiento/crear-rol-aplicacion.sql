-- =====================================================================
-- Rol de la aplicación con permisos mínimos (hallazgo A-3 de la auditoría)
-- =====================================================================
-- Qué hace:
--   * Crea el rol "agendamiento_app" (o le cambia la contraseña si ya existe).
--   * Le da SELECT, INSERT, UPDATE y DELETE en las tablas de la app y uso de las secuencias.
--   * NO puede borrar tablas, crear tablas ni cambiar la estructura (no es dueño de nada).
--   * auditoria_autorizaciones y actividad_superadmin: solo SELECT e INSERT (sin UPDATE ni DELETE).
--   * Las tablas que se creen después con migraciones reciben estos permisos por defecto.
--
-- Cómo usarlo (pgAdmin):
--   1. Conéctate con el usuario que hace las migraciones (hoy "postgres").
--   2. Abre Query Tool sobre la base (agendamiento_db) y pega este archivo completo.
--   3. Escribe la contraseña entre las comillas de "clave" (abajo). Mínimo 20 caracteres.
--   4. Ejecuta (F5). Se puede repetir sin problema: es idempotente.
--   5. BORRA la contraseña del script antes de guardarlo o compartirlo. Nunca lo subas a git con ella.
--
-- Antes de ejecutarlo, comprueba que el servidor no guarde las sentencias: SHOW log_statement;
-- debe responder "none" (con "all" o "ddl" la contraseña quedaría escrita en el log). Aun con
-- "none", una sentencia que FALLA se guarda con su texto (log_min_error_statement = error): si el
-- script da un error con la contraseña puesta, cámbiala después con otra ejecución correcta.
--
-- Si el script se ejecuta con la contraseña vacía, se detiene sin cambiar nada.
-- Una tabla nueva que deba ser "solo inserción" necesita su propio REVOKE UPDATE, DELETE
-- en la migración que la crea (los permisos por defecto sí incluyen UPDATE y DELETE).
-- =====================================================================

DO $rol_app$
DECLARE
  rol     constant text := 'agendamiento_app';
  clave   constant text := ' ';          -- <<< PON AQUÍ LA CONTRASEÑA, entre las comillas
  base    constant text := current_database();
  duenio  constant text := current_user;  -- quien crea las tablas (el usuario de las migraciones)
  tabla   text;
BEGIN
  IF length(btrim(clave)) < 20 THEN
    RAISE EXCEPTION 'Falta la contraseña: escríbela entre las comillas de "clave" (mínimo 20 caracteres) y vuelve a ejecutar. No se cambió nada.';
  END IF;

  -- 1. El rol: puede iniciar sesión y nada más (sin superusuario, sin crear bases ni roles)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rol) THEN
    EXECUTE format(
      'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      rol, clave);
  ELSE
    EXECUTE format(
      'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      rol, clave);
  END IF;

  -- 2. Conectarse a esta base y usar el esquema, sin poder crear nada en él
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', base, rol);
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM PUBLIC';
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', rol);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', rol);

  -- 3. Tablas: partir de cero y dar solo lo necesario
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', rol);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', rol);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', rol);

  -- 4. Tablas de solo inserción (la prueba legal y el registro del superadmin)
  FOREACH tabla IN ARRAY ARRAY['auditoria_autorizaciones', 'actividad_superadmin'] LOOP
    IF to_regclass(format('public.%I', tabla)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM %I', tabla, rol);
      EXECUTE format('GRANT SELECT, INSERT ON public.%I TO %I', tabla, rol);
    END IF;
  END LOOP;

  -- 5. Historial antiguo (la app ya no lo escribe) y control de migraciones (no es de la app)
  IF to_regclass('public.autorizaciones_datos') IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON public.autorizaciones_datos FROM %I', rol);
    EXECUTE format('GRANT SELECT ON public.autorizaciones_datos TO %I', rol);
  END IF;
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON public.schema_migrations FROM %I', rol);
  END IF;

  -- 6. Tablas y secuencias que cree el usuario de las migraciones más adelante
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    duenio, rol);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
    duenio, rol);

  RAISE NOTICE 'Listo: el rol % tiene permisos mínimos en la base %.', rol, base;
END
$rol_app$;
