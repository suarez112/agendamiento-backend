import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { fechaEnDias } from './apoyo/baseDePrueba.js';
import {
  CLAVE_ADMIN,
  CLAVE_CLIENTE,
  type Contexto,
  iniciar,
  iniciarSesion,
  pedir,
  registrarCliente,
  registrarEmpresa,
  SECRETO_PRUEBAS,
} from './apoyo/servidor.js';

const TOKEN_EXPO = 'ExponentPushToken[abc123_DEF-456]';

// M-4 — version_sesion también para el personal, y cierre de sesión en el servidor
describe('sesiones del personal y POST /logout', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  const agenda = (token: string) => pedir(ctx, '/api/v1/citas/agenda', { token });
  const cerrar = (token?: string) => pedir(ctx, '/api/v1/logout', { method: 'POST', token });

  test('el logout invalida el token del personal en el servidor, aunque no haya vencido', async () => {
    const token = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    assert.equal((await agenda(token)).estado, 200);
    const r = await cerrar(token);
    assert.equal(r.estado, 200);
    assert.deepEqual(r.json, { mensaje: 'Sesión cerrada' });
    assert.equal((await agenda(token)).estado, 401);
    // Puede volver a iniciar sesión
    assert.equal((await agenda(await iniciarSesion(ctx, 'barbero.a', 'clave-a'))).estado, 200);
  });

  test('cierra todas las sesiones de esa persona (otros celulares) y no las de otras', async () => {
    const celular1 = await iniciarSesion(ctx, 'barbero.a2', 'secreta');
    const celular2 = await iniciarSesion(ctx, 'barbero.a2', 'secreta');
    const otra = await iniciarSesion(ctx, 'admin.b', 'clave-b');
    assert.equal((await cerrar(celular1)).estado, 200);
    assert.equal((await agenda(celular1)).estado, 401);
    assert.equal((await agenda(celular2)).estado, 401);
    assert.equal((await agenda(otra)).estado, 200);
  });

  test('los tokens firmados antes de la migración (sin versión) siguen sirviendo hasta que la versión sube', async () => {
    const antiguo = jwt.sign({ empresaId: 'emp_a' }, SECRETO_PRUEBAS, { algorithm: 'HS256', subject: 'admin_a', expiresIn: '1h' });
    assert.equal((await agenda(antiguo)).estado, 200);
    assert.equal((await cerrar(antiguo)).estado, 200);
    assert.equal((await agenda(antiguo)).estado, 401);
  });

  test('un token con una versión que ya no es la actual no sirve', async () => {
    const token = await iniciarSesion(ctx, 'admin.a', '1234');
    await ctx.pool.query("UPDATE barberos SET version_sesion = version_sesion + 1 WHERE id = 'admin_a'");
    assert.equal((await agenda(token)).estado, 401);
  });

  test('sirve también para la cuenta de la administradora y la del cliente', async () => {
    const empresa = await registrarEmpresa(ctx, { correo: 'duena@central.co' });
    assert.equal(empresa.estado, 201, empresa.texto);
    const cliente = await registrarCliente(ctx, 'cliente.logout@correo.com', CLAVE_CLIENTE);
    for (const token of [empresa.json.token as string, cliente.json.token as string]) {
      assert.equal((await pedir(ctx, '/api/v1/notificaciones/no-leidas', { token })).estado, 200);
      assert.equal((await cerrar(token)).estado, 200);
      assert.equal((await pedir(ctx, '/api/v1/notificaciones/no-leidas', { token })).estado, 401);
    }
    // La cuenta puede volver a entrar
    const otra = await pedir(ctx, '/api/v1/cuentas/login', { method: 'POST', body: { correo: 'duena@central.co', clave: CLAVE_ADMIN } });
    assert.equal(otra.estado, 200);
  });

  test('borra los celulares registrados para notificaciones de quien cierra sesión', async () => {
    const token = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    const otro = await iniciarSesion(ctx, 'admin.b', 'clave-b');
    assert.equal((await pedir(ctx, '/api/v1/dispositivos', { method: 'PUT', token, body: { token: TOKEN_EXPO } })).estado, 200);
    assert.equal(
      (await pedir(ctx, '/api/v1/dispositivos', { method: 'PUT', token: otro, body: { token: 'ExponentPushToken[otro_celular]' } })).estado,
      200,
    );
    assert.equal((await cerrar(token)).estado, 200);
    const { rows } = await ctx.pool.query('SELECT token FROM dispositivos_push ORDER BY token');
    assert.deepEqual(rows, [{ token: 'ExponentPushToken[otro_celular]' }]);
  });

  test('sin token, con un token falso o con el de otro tipo responde 401', async () => {
    assert.equal((await cerrar()).estado, 401);
    assert.equal((await cerrar('falso')).estado, 401);
    const superadmin = jwt.sign({ tipo: 'superadmin', ver: 0 }, SECRETO_PRUEBAS, { algorithm: 'HS256', subject: 'x', expiresIn: '1h' });
    assert.equal((await cerrar(superadmin)).estado, 401);
  });

  test('cambiar la contraseña de un integrante cierra sus sesiones abiertas', async () => {
    const admin = await iniciarSesion(ctx, 'admin.a', '1234');
    const celularViejo = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    const cambio = await pedir(ctx, '/api/v1/equipo/barb_a', { method: 'PATCH', token: admin, body: { clave: 'Nueva-clave-1!' } });
    assert.equal(cambio.estado, 200, cambio.texto);
    assert.equal(cambio.json.token, undefined, 'el token nuevo solo se entrega a quien cambia su propia contraseña');
    assert.equal((await agenda(celularViejo)).estado, 401);
    // Con la contraseña anterior ya no entra; con la nueva sí
    assert.equal((await pedir(ctx, '/api/v1/auth/login', { method: 'POST', body: { usuario: 'barbero.a', clave: 'clave-a' } })).estado, 401);
    assert.equal((await agenda(await iniciarSesion(ctx, 'barbero.a', 'Nueva-clave-1!'))).estado, 200);
    // La sesión de quien hizo el cambio sigue valiendo
    assert.equal((await agenda(admin)).estado, 200);
  });

  test('si cambia su propia contraseña, recibe un token nuevo y se cierran las demás sesiones', async () => {
    const aqui = await iniciarSesion(ctx, 'admin.a', '1234');
    const otroCelular = await iniciarSesion(ctx, 'admin.a', '1234');
    const cambio = await pedir(ctx, '/api/v1/equipo/admin_a', { method: 'PATCH', token: aqui, body: { clave: 'Otra-clave-2!' } });
    assert.equal(cambio.estado, 200, cambio.texto);
    assert.equal(typeof cambio.json.token, 'string');
    assert.equal((await agenda(aqui)).estado, 401, 'el token anterior de esta sesión ya no sirve');
    assert.equal((await agenda(otroCelular)).estado, 401, 'la sesión del otro celular se cerró');
    assert.equal((await agenda(cambio.json.token)).estado, 200, 'el token nuevo sí');
    assert.equal((await iniciarSesion(ctx, 'admin.a', 'Otra-clave-2!')).length > 0, true);
  });

  test('cambiar la contraseña de un integrante borra los tokens de notificaciones de sus celulares, y solo los suyos', async () => {
    const admin = await iniciarSesion(ctx, 'admin.a', 'Otra-clave-2!');
    const barbero = await iniciarSesion(ctx, 'barbero.a', 'Nueva-clave-1!');
    await ctx.pool.query('DELETE FROM dispositivos_push');
    const registrar = async (token: string, tokenExpo: string) =>
      assert.equal((await pedir(ctx, '/api/v1/dispositivos', { method: 'PUT', token, body: { token: tokenExpo } })).estado, 200);
    await registrar(barbero, 'ExponentPushToken[celular_uno]');
    await registrar(barbero, 'ExponentPushToken[celular_dos]');
    await registrar(admin, 'ExponentPushToken[celular_admin]');
    const tokens = async () => (await ctx.pool.query('SELECT token FROM dispositivos_push ORDER BY token')).rows.map((f) => f.token);

    // Editar otros datos no toca los celulares
    const sinClave = await pedir(ctx, '/api/v1/equipo/barb_a', { method: 'PATCH', token: admin, body: { especialidad: 'Barbero' } });
    assert.equal(sinClave.estado, 200, sinClave.texto);
    assert.equal((await tokens()).length, 3);

    const cambio = await pedir(ctx, '/api/v1/equipo/barb_a', { method: 'PATCH', token: admin, body: { clave: 'Tercera-clave-3!' } });
    assert.equal(cambio.estado, 200, cambio.texto);
    assert.deepEqual(await tokens(), ['ExponentPushToken[celular_admin]'], 'solo quedan los de otras personas');
  });

  test('si el integrante cambia su propia contraseña, también se borran sus celulares', async () => {
    const admin = await iniciarSesion(ctx, 'admin.a', 'Otra-clave-2!');
    assert.equal((await pedir(ctx, '/api/v1/dispositivos', { method: 'PUT', token: admin, body: { token: TOKEN_EXPO } })).estado, 200);
    const propio = await pedir(ctx, '/api/v1/equipo/admin_a', { method: 'PATCH', token: admin, body: { clave: 'Quinta-clave-5!' } });
    assert.equal(propio.estado, 200, propio.texto);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM dispositivos_push WHERE barbero_id = 'admin_a'")).rows[0].n, 0);
  });

  test('editar otros datos (sin contraseña) no cierra sesiones', async () => {
    const admin = await iniciarSesion(ctx, 'admin.b', 'clave-b');
    const cambio = await pedir(ctx, '/api/v1/equipo/admin_b', { method: 'PATCH', token: admin, body: { especialidad: 'Barbero' } });
    assert.equal(cambio.estado, 200, cambio.texto);
    assert.equal(cambio.json.token, undefined);
    assert.equal((await agenda(admin)).estado, 200);
  });
});
