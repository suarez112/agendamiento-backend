import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { type Contexto, iniciar, iniciarSesion, pedir, SECRETO_PRUEBAS } from './apoyo/servidor.js';

// S5 — autenticación, contraseñas y tokens
describe('autenticación', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  const login = (usuario: unknown, clave: unknown) =>
    pedir(ctx, '/api/v1/auth/login', { method: 'POST', body: { usuario, clave } });

  test('una contraseña heredada en texto plano funciona y queda cifrada con bcrypt', async () => {
    const r = await login('barbero.a', 'clave-a');
    assert.equal(r.estado, 200);
    assert.equal(r.json.barbero.id, 'barb_a');
    assert.equal(typeof r.json.token, 'string');

    const { rows } = await ctx.pool.query("SELECT password_hash FROM barberos WHERE id = 'barb_a'");
    assert.match(rows[0].password_hash, /^\$2[aby]\$12\$/);
    assert.equal((await login('barbero.a', 'clave-a')).estado, 200, 'sigue entrando con el hash nuevo');
  });

  test('una contraseña guardada con bcrypt se verifica', async () => {
    const r = await login('barbero.a2', 'secreta');
    assert.equal(r.estado, 200);
    assert.equal(r.json.barbero.id, 'barb_a2');
  });

  test('usuario inexistente y clave incorrecta responden igual', async () => {
    const incorrecta = await login('barbero.a2', 'otra');
    const inexistente = await login('nadie', 'otra');
    assert.equal(incorrecta.estado, 401);
    assert.equal(inexistente.estado, 401);
    assert.deepEqual(incorrecta.json, inexistente.json);
  });

  test('inyección SQL en el usuario no inicia sesión', async () => {
    for (const usuario of ["' OR '1'='1", "admin.a' --", "x' UNION SELECT * FROM barberos --"]) {
      const r = await login(usuario, "' OR '1'='1");
      assert.equal(r.estado, 401, usuario);
    }
  });

  test('datos con tipos incorrectos responden 400 en JSON', async () => {
    const r = await login({ $ne: '' }, 123);
    assert.equal(r.estado, 400);
    assert.equal(r.json.error, 'Debes enviar usuario y contraseña');
  });

  test('un token alterado, sin firma o firmado con otro secreto es rechazado', async () => {
    const valido = await iniciarSesion(ctx, 'admin.a', '1234');
    const [cabecera, , firma] = valido.split('.');
    const carga = Buffer.from(JSON.stringify({ sub: 'admin_b', empresaId: 'emp_b', barberoId: 'admin_b', esAdmin: true })).toString('base64url');
    const sinFirma = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${carga}.`;
    const otroSecreto = jwt.sign({ sub: 'admin_a', empresaId: 'emp_a', barberoId: 'admin_a', esAdmin: true }, 'otro-secreto');

    for (const token of [`${cabecera}.${carga}.${firma}`, sinFirma, otroSecreto, 'basura']) {
      const r = await pedir(ctx, '/api/v1/citas/agenda', { token });
      assert.equal(r.estado, 401);
    }
  });

  test('un token vencido es rechazado', async () => {
    const vencido = jwt.sign(
      { sub: 'admin_a', empresaId: 'emp_a', barberoId: 'admin_a', esAdmin: true, exp: Math.floor(Date.now() / 1000) - 60 },
      SECRETO_PRUEBAS,
    );
    assert.equal((await pedir(ctx, '/api/v1/citas/agenda', { token: vencido })).estado, 401);
  });

  test('quitar el rol de admin aplica de inmediato aunque el token siga vigente', async () => {
    const token = await iniciarSesion(ctx, 'admin.b', 'clave-b');
    await ctx.pool.query("UPDATE barberos SET es_admin = false WHERE id = 'admin_b'");
    try {
      const r = await pedir(ctx, '/api/v1/citas/cita_b/cancelar', { method: 'PATCH', token });
      assert.equal(r.estado, 403);
      const { rows } = await ctx.pool.query("SELECT estado FROM citas WHERE id = 'cita_b'");
      assert.equal(rows[0].estado, 'CONFIRMADA');
    } finally {
      await ctx.pool.query("UPDATE barberos SET es_admin = true WHERE id = 'admin_b'");
    }
  });

  test('un barbero eliminado pierde el acceso', async () => {
    await ctx.pool.query(
      "INSERT INTO barberos (id, empresa_id, nombre, usuario, password_hash) VALUES ('temporal', 'emp_a', 'Temporal', 'temporal', 'tmp-1')",
    );
    const token = await iniciarSesion(ctx, 'temporal', 'tmp-1');
    await ctx.pool.query("DELETE FROM barberos WHERE id = 'temporal'");
    assert.equal((await pedir(ctx, '/api/v1/citas/agenda', { token })).estado, 401);
  });
});

// S10 — limitación de intentos de inicio de sesión
describe('límite de intentos de inicio de sesión', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar({ limites: { login: 3 } });
  });
  after(() => ctx.cerrar());

  test('tras 3 intentos fallidos responde 429, aun con la clave correcta', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await pedir(ctx, '/api/v1/auth/login', { method: 'POST', body: { usuario: 'admin.a', clave: 'mal' } });
      assert.equal(r.estado, 401);
    }
    const bloqueado = await pedir(ctx, '/api/v1/auth/login', { method: 'POST', body: { usuario: 'admin.a', clave: '1234' } });
    assert.equal(bloqueado.estado, 429);
    assert.match(bloqueado.json.error, /Demasiados intentos/);
  });
});
