import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { cargarEntornoBaseDeDatos, cargarEntornoMigraciones } from '../src/config/entorno.js';
import { crearBaseDePrueba, type BaseDePrueba } from './apoyo/baseDePrueba.js';
import { leerConfigPruebas } from './apoyo/configuracionPruebas.js';

// A-3 — la app se conecta con un rol de permisos mínimos y las migraciones con otro usuario.

const BASE = { DB_HOST: 'localhost', DB_PORT: '5432', DB_USER: 'agendamiento_app', DB_PASSWORD: 'clave-app', DB_NAME: 'agendamiento_db' };

describe('usuario de las migraciones separado del de la app', () => {
  test('sin DB_MIGRACION_USER las migraciones usan DB_USER (como antes)', () => {
    const entorno = cargarEntornoMigraciones({ ...BASE });
    assert.deepEqual([entorno.DB_USER, entorno.DB_PASSWORD], ['agendamiento_app', 'clave-app']);
  });

  test('con DB_MIGRACION_USER las migraciones usan ese usuario y la app sigue con DB_USER', () => {
    const fuente = { ...BASE, DB_MIGRACION_USER: 'postgres', DB_MIGRACION_PASSWORD: 'clave-migraciones' };
    const migraciones = cargarEntornoMigraciones(fuente);
    assert.deepEqual([migraciones.DB_USER, migraciones.DB_PASSWORD], ['postgres', 'clave-migraciones']);
    const app = cargarEntornoBaseDeDatos(fuente);
    assert.deepEqual([app.DB_USER, app.DB_PASSWORD], ['agendamiento_app', 'clave-app']);
  });

  test('una contraseña de base de datos que falta o está vacía da un error claro', () => {
    const { DB_PASSWORD: _omitida, ...sinClave } = BASE;
    assert.throws(() => cargarEntornoBaseDeDatos(sinClave), /DB_PASSWORD: falta/);
    assert.throws(() => cargarEntornoBaseDeDatos({ ...BASE, DB_PASSWORD: '' }), /DB_PASSWORD: está vacía/);
    for (const clave of [undefined, '']) {
      assert.throws(
        () => cargarEntornoMigraciones({ ...BASE, DB_MIGRACION_USER: 'postgres', DB_MIGRACION_PASSWORD: clave }),
        /DB_MIGRACION_PASSWORD: falta o está vacía/,
      );
    }
  });

  test('las pruebas no mezclan el usuario de un grupo con la contraseña de otro', () => {
    const base = {
      ...BASE,
      TEST_DB_NAME: 'agendamiento_test',
      DB_MIGRACION_USER: 'postgres',
      DB_MIGRACION_PASSWORD: 'clave-migraciones',
    };
    assert.throws(() => leerConfigPruebas({ ...base, TEST_DB_USER: 'agendamiento_test' }), /TEST_DB_USER.*falta TEST_DB_PASSWORD/s);
    assert.throws(
      () => leerConfigPruebas({ ...base, DB_MIGRACION_PASSWORD: undefined }),
      /DB_MIGRACION_USER.*falta DB_MIGRACION_PASSWORD/s,
    );
    const propio = leerConfigPruebas({ ...base, TEST_DB_USER: 'agendamiento_test', TEST_DB_PASSWORD: 'clave-pruebas' });
    assert.deepEqual([propio.user, propio.password], ['agendamiento_test', 'clave-pruebas']);
  });

  test('las pruebas no usan el usuario limitado de la app: toman el de las migraciones', () => {
    const config = leerConfigPruebas({
      ...BASE,
      TEST_DB_NAME: 'agendamiento_test',
      DB_MIGRACION_USER: 'postgres',
      DB_MIGRACION_PASSWORD: 'clave-migraciones',
    });
    assert.deepEqual([config.user, config.password], ['postgres', 'clave-migraciones']);
  });
});

const ROL_PRUEBA = `agendamiento_app_prueba_${process.pid}`;
const CLAVE_PRUEBA = 'clave-solo-para-pruebas-0123456789';

describe('script db/mantenimiento/crear-rol-aplicacion.sql', () => {
  let base: BaseDePrueba;
  let omitir: string | undefined;
  let conRol: pg.Client;

  const conectar = async (usuario: string, password: string) => {
    const config = leerConfigPruebas();
    const cliente = new pg.Client({ host: config.host, port: config.port, user: usuario, password, database: base.nombre });
    await cliente.connect();
    return cliente;
  };

  before(async () => {
    base = await crearBaseDePrueba();
    const { rows } = await base.pool.query<{ puede: boolean }>(
      'SELECT (rolcreaterole OR rolsuper) AS puede FROM pg_roles WHERE rolname = current_user',
    );
    if (!rows[0]?.puede) {
      omitir = 'el usuario de pruebas no puede crear roles (CREATEROLE)';
      return;
    }
    const original = await readFile(new URL('../db/mantenimiento/crear-rol-aplicacion.sql', import.meta.url), 'utf8');
    // Nunca se toca el rol real: se cambia el nombre y se pone una contraseña de prueba
    const sql = original
      .replace("rol     constant text := 'agendamiento_app';", `rol     constant text := '${ROL_PRUEBA}';`)
      .replace("clave   constant text := ' ';", `clave   constant text := '${CLAVE_PRUEBA}';`);
    assert.ok(sql.includes(ROL_PRUEBA) && sql.includes(CLAVE_PRUEBA), 'el script cambió de forma: actualiza la prueba');
    await base.pool.query(sql);
    conRol = await conectar(ROL_PRUEBA, CLAVE_PRUEBA);
  });

  after(async () => {
    await conRol?.end();
    if (!omitir) {
      await base.pool.query(`DROP OWNED BY "${ROL_PRUEBA}"`);
      await base.pool.query(`DROP ROLE IF EXISTS "${ROL_PRUEBA}"`);
    }
    await base.destruir();
  });

  const denegado = (sql: string) => async () => {
    await assert.rejects(conRol.query(sql), (e: { code?: string }) => e.code === '42501', sql);
  };

  test('el rol no es superusuario ni puede crear bases o roles', async (t) => {
    if (omitir) return t.skip(omitir);
    const { rows } = await base.pool.query(
      'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [ROL_PRUEBA],
    );
    assert.deepEqual(Object.values(rows[0]), [false, false, false, false, false]);
  });

  test('puede leer, insertar, modificar y borrar en las tablas de la app', async (t) => {
    if (omitir) return t.skip(omitir);
    await conRol.query("INSERT INTO categorias_negocio (nombre) VALUES ('Prueba del rol')");
    await conRol.query("UPDATE categorias_negocio SET nombre = 'Prueba del rol 2' WHERE nombre = 'Prueba del rol'");
    const { rows } = await conRol.query("SELECT nombre FROM categorias_negocio WHERE nombre = 'Prueba del rol 2'");
    assert.equal(rows.length, 1);
    await conRol.query("DELETE FROM categorias_negocio WHERE nombre = 'Prueba del rol 2'");
    await conRol.query("SELECT nextval('pqrs_numero_seq')");
  });

  test('no puede borrar tablas, vaciarlas, crear tablas ni cambiar la estructura', async (t) => {
    if (omitir) return t.skip(omitir);
    for (const sql of [
      'DROP TABLE citas',
      'TRUNCATE citas',
      'CREATE TABLE tabla_intrusa (id int)',
      'ALTER TABLE citas ADD COLUMN intrusa int',
      'DROP TABLE auditoria_autorizaciones',
      'ALTER TABLE auditoria_autorizaciones DISABLE TRIGGER USER',
      'DROP TRIGGER auditoria_autorizaciones_sin_cambios ON auditoria_autorizaciones',
      'SELECT version FROM schema_migrations',
    ]) {
      await denegado(sql)();
    }
  });

  test('la auditoría de autorizaciones solo admite SELECT e INSERT', async (t) => {
    if (omitir) return t.skip(omitir);
    await conRol.query(
      "INSERT INTO auditoria_autorizaciones (telefono, canal, version_politica, version_terminos) VALUES ('+573100000099', 'reserva_invitado', '1.0', '1.0')",
    );
    const { rows } = await conRol.query('SELECT count(*)::int AS total FROM auditoria_autorizaciones');
    assert.equal(rows[0].total, 1);
    for (const sql of [
      "UPDATE auditoria_autorizaciones SET version_politica = '0.0'",
      'DELETE FROM auditoria_autorizaciones',
      'TRUNCATE auditoria_autorizaciones',
      "UPDATE actividad_superadmin SET accion = 'otra'",
      'DELETE FROM actividad_superadmin',
    ]) {
      await denegado(sql)();
    }
  });

  test('una tabla creada después por las migraciones queda con permisos de lectura y escritura', async (t) => {
    if (omitir) return t.skip(omitir);
    await base.pool.query('CREATE TABLE tabla_nueva_prueba (id serial PRIMARY KEY, dato text)');
    await conRol.query("INSERT INTO tabla_nueva_prueba (dato) VALUES ('hola')");
    await conRol.query("UPDATE tabla_nueva_prueba SET dato = 'adiós'");
    await conRol.query('DELETE FROM tabla_nueva_prueba');
  });

  test('con la contraseña en blanco el script se detiene sin cambiar nada', async (t) => {
    if (omitir) return t.skip(omitir);
    const original = await readFile(new URL('../db/mantenimiento/crear-rol-aplicacion.sql', import.meta.url), 'utf8');
    const sql = original.replace("rol     constant text := 'agendamiento_app';", "rol     constant text := 'agendamiento_app_sin_clave';");
    await assert.rejects(base.pool.query(sql), /Falta la contraseña/);
    const { rows } = await base.pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'agendamiento_app_sin_clave'");
    assert.equal(rows.length, 0);
  });
});
