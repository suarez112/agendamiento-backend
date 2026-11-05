import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { type Contexto, iniciar, iniciarSesion, iniciarSesionCuenta, pedir } from './apoyo/servidor.js';

const RUTA = '/api/v1/admin/empresa/privacidad-clientes';

// Opción "los empleados pueden ver el teléfono de los clientes": apagada por defecto, solo la cambia un administrador
describe('opción del negocio: teléfono de los clientes para los empleados', () => {
  let ctx: Contexto;
  let tokenAdmin: string; // integrante con rol Administrador
  let tokenCuentaAdmin: string; // cuenta de administración (correo)
  let tokenEmpleado: string;
  let tokenAdminB: string;

  before(async () => {
    ctx = await iniciar();
    await ctx.pool.query(
      `INSERT INTO usuarios (correo, usuario, password_hash, rol, empresa_id) VALUES ('cuenta.a@negocio.co', 'cuenta.a', $1, 'admin', 'emp_a')`,
      [await bcrypt.hash('Clave-cuenta-1!', 4)],
    );
    tokenAdmin = await iniciarSesion(ctx, 'admin.a', '1234');
    tokenEmpleado = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    tokenAdminB = await iniciarSesion(ctx, 'admin.b', 'clave-b');
    tokenCuentaAdmin = (await iniciarSesionCuenta(ctx, 'cuenta.a@negocio.co', 'Clave-cuenta-1!')).json.token;
  });
  after(() => ctx.cerrar());

  const cambiar = (token: string, body: unknown) => pedir(ctx, RUTA, { method: 'PUT', token, body });

  test('está apagada por defecto, también en los negocios que ya existían', async () => {
    const r = await pedir(ctx, RUTA, { token: tokenAdmin });
    assert.equal(r.estado, 200, r.texto);
    assert.deepEqual(r.json, { empleadosVenTelefono: false });
    const columna = await ctx.pool.query('SELECT count(*)::int AS n FROM empresas WHERE empleados_ven_telefono');
    assert.equal(columna.rows[0].n, 0);
  });

  test('un integrante administrador y la cuenta de administración la cambian', async () => {
    const encender = await cambiar(tokenAdmin, { empleadosVenTelefono: true });
    assert.equal(encender.estado, 200, encender.texto);
    assert.deepEqual(encender.json, {
      mensaje: 'Ahora los empleados pueden ver el teléfono de los clientes',
      empleadosVenTelefono: true,
    });
    assert.deepEqual((await pedir(ctx, RUTA, { token: tokenCuentaAdmin })).json, { empleadosVenTelefono: true });

    const apagar = await cambiar(tokenCuentaAdmin, { empleadosVenTelefono: false });
    assert.equal(apagar.estado, 200, apagar.texto);
    assert.deepEqual(apagar.json, {
      mensaje: 'Los empleados ya no ven el teléfono de los clientes',
      empleadosVenTelefono: false,
    });
    const fila = await ctx.pool.query("SELECT empleados_ven_telefono FROM empresas WHERE id = 'emp_a'");
    assert.equal(fila.rows[0].empleados_ven_telefono, false);
  });

  test('un empleado no la puede ver ni cambiar (403) y no cambia nada', async () => {
    const ver = await pedir(ctx, RUTA, { token: tokenEmpleado });
    assert.equal(ver.estado, 403);
    assert.equal(ver.json.error, 'Solo el administrador del negocio puede usar esta función.');
    const cambio = await cambiar(tokenEmpleado, { empleadosVenTelefono: true });
    assert.equal(cambio.estado, 403);
    const fila = await ctx.pool.query("SELECT empleados_ven_telefono FROM empresas WHERE id = 'emp_a'");
    assert.equal(fila.rows[0].empleados_ven_telefono, false);
    assert.equal((await pedir(ctx, RUTA)).estado, 401);
  });

  test('cada administrador cambia solo su propio negocio', async () => {
    assert.equal((await cambiar(tokenAdminB, { empleadosVenTelefono: true })).estado, 200);
    const filas = await ctx.pool.query("SELECT id, empleados_ven_telefono AS v FROM empresas WHERE id IN ('emp_a', 'emp_b') ORDER BY id");
    assert.deepEqual(filas.rows, [{ id: 'emp_a', v: false }, { id: 'emp_b', v: true }]);
    assert.equal((await cambiar(tokenAdminB, { empleadosVenTelefono: false })).estado, 200);
  });

  test('valida el cuerpo', async () => {
    for (const body of [{}, { empleadosVenTelefono: 'si' }, { empleadosVenTelefono: 1 }, { empleadosVenTelefono: null }]) {
      const r = await cambiar(tokenAdmin, body);
      assert.equal(r.estado, 400, JSON.stringify(body));
      assert.equal(r.json.error, 'Envía "empleadosVenTelefono": true o false');
    }
  });
});
