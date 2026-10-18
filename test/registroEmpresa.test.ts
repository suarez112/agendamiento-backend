import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { aplicarMigraciones } from '../src/db/migraciones.js';
import { type BaseDePrueba, crearBaseDePrueba } from './apoyo/baseDePrueba.js';

// Migración 003: perfil de empresa, periodo de prueba y roles de usuario
describe('migración 003: registro de empresa', () => {
  let base: BaseDePrueba;
  before(async () => {
    // Las empresas sembradas existen antes de la 003, como en producción
    base = await crearBaseDePrueba({ hasta: '002' });
    await aplicarMigraciones(base.pool);
  });
  after(() => base.destruir());

  const ejecutar = (sql: string, valores: unknown[] = []) => base.pool.query(sql, valores);

  const rechaza = async (sql: string, restriccion: string, valores: unknown[] = []) => {
    await assert.rejects(ejecutar(sql, valores), (error: { constraint?: string }) => {
      assert.equal(error.constraint, restriccion);
      return true;
    });
  };

  const nuevaEmpresa = (id: string, columnas = '', valores = '') =>
    `INSERT INTO empresas (id, nombre, codigo_acceso${columnas}) VALUES ('${id}', 'Empresa ${id}', '${id.toUpperCase()}'${valores})`;

  test('las empresas existentes conservan sus datos y quedan activas', async () => {
    const { rows } = await ejecutar(
      "SELECT nombre, codigo_acceso, estado_suscripcion, trial_ends_at, nit FROM empresas WHERE id = 'emp_a'",
    );
    assert.deepEqual(rows, [
      { nombre: 'Negocio A', codigo_acceso: 'NEGA', estado_suscripcion: 'activa', trial_ends_at: null, nit: null },
    ]);
  });

  test('una empresa nueva queda en prueba y guarda su perfil completo', async () => {
    await ejecutar(
      `INSERT INTO empresas (id, nombre, codigo_acceso, categoria, nit, telefono, correo, direccion, ciudad,
         dias_atencion, horario_apertura, horario_cierre, nombre_administradora, numero_empleados, logo_url, trial_ends_at)
       VALUES ('emp_n', 'Nueva', 'NUEVA', 'Barbería', '900123456-7', '3001234567', 'hola@nueva.co', 'Calle 1 # 2-3',
         'Bucaramanga', '{1,2,3,4,5,6}', '09:00', '19:00', 'Ana Pérez', 4, 'https://cdn.nueva.co/logo.png',
         now() + interval '14 days')`,
    );
    const { rows } = await ejecutar(
      "SELECT estado_suscripcion, dias_atencion, numero_empleados, created_at IS NOT NULL AS creada FROM empresas WHERE id = 'emp_n'",
    );
    assert.deepEqual(rows, [{ estado_suscripcion: 'trial', dias_atencion: [1, 2, 3, 4, 5, 6], numero_empleados: 4, creada: true }]);
  });

  test('rechaza valores inválidos del perfil', async () => {
    await rechaza(nuevaEmpresa('e1', ', estado_suscripcion', ", 'gratis'"), 'empresas_estado_suscripcion_valido');
    await rechaza(nuevaEmpresa('e2', ', dias_atencion', ", '{7}'"), 'empresas_dias_atencion_validos');
    await rechaza(nuevaEmpresa('e3', ', dias_atencion', ", '{}'"), 'empresas_dias_atencion_validos');
    await rechaza(nuevaEmpresa('e4', ', dias_atencion', ", '{1,NULL}'"), 'empresas_dias_atencion_validos');
    await rechaza(nuevaEmpresa('e5', ', numero_empleados', ', 0'), 'empresas_numero_empleados_valido');
    await rechaza(nuevaEmpresa('e6', ', correo', ", 'sin-arroba'"), 'empresas_correo_valido');
    await rechaza(nuevaEmpresa('e7', ', logo_url', ", 'javascript:alert(1)'"), 'empresas_logo_url_valida');
  });

  test('el NIT es opcional pero no se repite', async () => {
    await ejecutar(nuevaEmpresa('sin_nit_1'));
    await ejecutar(nuevaEmpresa('sin_nit_2'));
    await ejecutar(nuevaEmpresa('con_nit', ', nit', ", '800111222-3'"));
    await rechaza(nuevaEmpresa('nit_repetido', ', nit', ", '800111222-3'"), 'empresas_nit_key');
  });

  test('un admin pertenece a una empresa y un cliente a ninguna', async () => {
    const usuario = 'INSERT INTO usuarios (correo, password_hash, rol, empresa_id) VALUES ($1, $2, $3, $4)';
    await ejecutar(usuario, ['admin@a.co', 'hash', 'admin', 'emp_a']);
    await ejecutar(usuario, ['cliente@x.co', 'hash', 'cliente', null]);
    await rechaza(usuario, 'usuarios_empresa_segun_rol', ['admin2@a.co', 'hash', 'admin', null]);
    await rechaza(usuario, 'usuarios_empresa_segun_rol', ['cliente2@x.co', 'hash', 'cliente', 'emp_a']);
    await rechaza(usuario, 'usuarios_rol_valido', ['root@x.co', 'hash', 'superadmin', null]);
    await rechaza(usuario, 'usuarios_empresa_id_fkey', ['fantasma@x.co', 'hash', 'admin', 'no_existe']);
    await rechaza(usuario, 'usuarios_correo_valido', ['sin-arroba', 'hash', 'cliente', null]);
  });

  test('el correo de usuario no se repite aunque cambien las mayúsculas', async () => {
    await ejecutar("INSERT INTO usuarios (correo, password_hash, rol) VALUES ('Ana@Correo.co', 'hash', 'cliente')");
    await rechaza(
      "INSERT INTO usuarios (correo, password_hash, rol) VALUES ('ana@correo.co', 'hash', 'cliente')",
      'usuarios_correo_lower_key',
    );
  });

  test('eliminar una empresa elimina a su admin', async () => {
    await ejecutar(nuevaEmpresa('emp_borrar'));
    await ejecutar("INSERT INTO usuarios (correo, password_hash, rol, empresa_id) VALUES ('borrar@x.co', 'h', 'admin', 'emp_borrar')");
    await ejecutar("DELETE FROM empresas WHERE id = 'emp_borrar'");
    const { rows } = await ejecutar("SELECT count(*)::int AS n FROM usuarios WHERE correo = 'borrar@x.co'");
    assert.equal(rows[0].n, 0);
  });
});
