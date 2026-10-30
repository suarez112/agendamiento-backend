import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { cargarEntorno } from '../src/config/entorno.js';
import { cifrarContrasena } from '../src/modules/auth/contrasenas.js';
import { crearServicioIntentos } from '../src/modules/auth/intentos.js';
import { crearServicioRecuperacion } from '../src/modules/cuentas/recuperacion.servicio.js';
import { recifrarSegundosPasos } from '../src/modules/superadmin/recifrado.js';
import { cifrarSecreto, codigoTotp, generarSecretoTotp } from '../src/modules/superadmin/totp.js';
import {
  CLAVE_CLIENTE,
  type Contexto,
  iniciar,
  iniciarSesion,
  pedir,
  registrarCliente,
  SECRETO_PRUEBAS,
  esperarHasta,
  SECRETO_RECUPERACION_PRUEBAS,
  SECRETO_TOTP_PRUEBAS,
} from './apoyo/servidor.js';

const JWT = 'a'.repeat(40);
const RECUPERACION = 'b'.repeat(40);
const TOTP = 'c'.repeat(40);
const base = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', JWT_SECRET: JWT, ...extra };
  // El proveedor de pago del .env de quien corre las pruebas no debe influir en estas
  delete env.PROVEEDOR_PAGO;
  if (!('RECUPERACION_SECRET' in extra)) delete env.RECUPERACION_SECRET;
  if (!('TOTP_SECRET' in extra)) delete env.TOTP_SECRET;
  return env;
};

// B-4 — un secreto para las sesiones, otro para los códigos de recuperación y otro para el segundo paso
describe('tres secretos independientes: configuración', () => {
  test('con los tres definidos, cada uso lee el suyo', () => {
    const e = cargarEntorno(base({ RECUPERACION_SECRET: RECUPERACION, TOTP_SECRET: TOTP }));
    assert.deepEqual([e.JWT_SECRET, e.RECUPERACION_SECRET, e.TOTP_SECRET], [JWT, RECUPERACION, TOTP]);
  });

  test('son obligatorios en todos los entornos: no hay respaldo en JWT_SECRET', () => {
    for (const NODE_ENV of ['test', 'development', 'production']) {
      assert.throws(() => cargarEntorno(base({ NODE_ENV })), /RECUPERACION_SECRET[\s\S]*TOTP_SECRET/, NODE_ENV);
      assert.throws(() => cargarEntorno(base({ NODE_ENV, RECUPERACION_SECRET: RECUPERACION })), /TOTP_SECRET/, NODE_ENV);
    }
    assert.doesNotThrow(() => cargarEntorno(base({ NODE_ENV: 'production', RECUPERACION_SECRET: RECUPERACION, TOTP_SECRET: TOTP })));
  });

  test('deben ser distintos entre sí y de JWT_SECRET, y tener al menos 32 caracteres', () => {
    assert.throws(() => cargarEntorno(base({ RECUPERACION_SECRET: JWT, TOTP_SECRET: TOTP })), /RECUPERACION_SECRET.*distinto de JWT_SECRET/);
    assert.throws(() => cargarEntorno(base({ RECUPERACION_SECRET: RECUPERACION, TOTP_SECRET: JWT })), /TOTP_SECRET.*distinto de JWT_SECRET/);
    assert.throws(() => cargarEntorno(base({ RECUPERACION_SECRET: RECUPERACION, TOTP_SECRET: RECUPERACION })), /TOTP_SECRET.*distinto de RECUPERACION_SECRET/);
    assert.throws(() => cargarEntorno(base({ RECUPERACION_SECRET: RECUPERACION, TOTP_SECRET: 'corto' })), /TOTP_SECRET.*32/);
  });
});

describe('tres secretos independientes: cada uno protege solo lo suyo', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  test('las sesiones se firman con JWT_SECRET: un token firmado con los otros secretos no sirve', async () => {
    const firmar = (secreto: string) => jwt.sign({ empresaId: 'emp_a' }, secreto, { algorithm: 'HS256', subject: 'admin_a', expiresIn: '1h' });
    assert.equal((await pedir(ctx, '/api/v1/citas/agenda', { token: firmar(SECRETO_PRUEBAS) })).estado, 200);
    assert.equal((await pedir(ctx, '/api/v1/citas/agenda', { token: firmar(SECRETO_RECUPERACION_PRUEBAS) })).estado, 401);
    assert.equal((await pedir(ctx, '/api/v1/citas/agenda', { token: firmar(SECRETO_TOTP_PRUEBAS) })).estado, 401);
    assert.ok(await iniciarSesion(ctx, 'admin.a', '1234'));
  });

  test('el segundo paso del superadmin se cifra con TOTP_SECRET, no con el de las sesiones', async () => {
    const secreto = generarSecretoTotp();
    const clave = 'Super-admin-123!';
    const entrar = async (correo: string) =>
      (await pedir(ctx, '/api/v1/superadmin/login', { method: 'POST', body: { correo, clave, codigo: codigoTotp(secreto) } })).estado;
    const insertar = async (correo: string, llave: string) =>
      ctx.pool.query('INSERT INTO superadmins (correo, password_hash, totp_secreto) VALUES ($1, $2, $3)', [
        correo,
        await cifrarContrasena(clave),
        cifrarSecreto(secreto, llave),
      ]);
    await insertar('con.totp@plataforma.co', SECRETO_TOTP_PRUEBAS);
    await insertar('con.jwt@plataforma.co', SECRETO_PRUEBAS);
    assert.equal(await entrar('con.totp@plataforma.co'), 200);
    assert.equal(await entrar('con.jwt@plataforma.co'), 401, 'cifrado con la llave de las sesiones: ya no se puede leer');
  });

  test('los códigos de recuperación se protegen con RECUPERACION_SECRET', async () => {
    const registro = await registrarCliente(ctx, 'recupera@correo.com', CLAVE_CLIENTE);
    assert.equal(registro.estado, 201, registro.texto);
    let texto = '';
    const correo = { enviar: async (m: { texto: string }) => void (texto = m.texto) };
    const conSecreto = (secreto: string) => crearServicioRecuperacion({ pool: ctx.pool, secreto, correo, intentos: crearServicioIntentos(ctx.pool, { max: 10, ventanaMs: 60_000, bloqueoBaseMs: 1_000, bloqueoMaxMs: 4_000 }) });
    await conSecreto(SECRETO_RECUPERACION_PRUEBAS).solicitar('recupera@correo.com');
    const codigo = (await esperarHasta(async () => texto.match(/\b(\d{6})\b/)))[1];
    const datos = { correo: 'recupera@correo.com', codigo, clave: 'Nueva-clave-9!' };
    // Con el secreto de las sesiones el código no coincide
    await assert.rejects(conSecreto(SECRETO_PRUEBAS).restablecer(datos), { estado: 400 });
    texto = '';
    await conSecreto(SECRETO_RECUPERACION_PRUEBAS).solicitar('recupera@correo.com');
    const nuevo = (await esperarHasta(async () => texto.match(/\b(\d{6})\b/)))[1];
    const ok = await conSecreto(SECRETO_RECUPERACION_PRUEBAS).restablecer({ ...datos, codigo: nuevo });
    assert.match(ok.mensaje, /Tu contraseña se cambió/);
  });
});

// B-4 — cambiar TOTP_SECRET no obliga a configurar de nuevo el 2FA: db:recifrar-2fa vuelve a cifrar la clave
describe('db:recifrar-2fa', () => {
  let ctx: Contexto;
  const NUEVA = 'secreto-nuevo-del-segundo-paso-1234567890';
  before(async () => {
    ctx = await iniciar({ entorno: { TOTP_SECRET: NUEVA } });
  });
  after(() => ctx.cerrar());

  test('antes de re-cifrar no entra; después entra con el mismo código de la app que ya tenía', async () => {
    const secreto = generarSecretoTotp();
    const clave = 'Super-admin-123!';
    await ctx.pool.query('INSERT INTO superadmins (correo, password_hash, totp_secreto) VALUES ($1, $2, $3)', [
      'rota@plataforma.co',
      await cifrarContrasena(clave),
      cifrarSecreto(secreto, SECRETO_PRUEBAS), // como estaba antes de B-4: cifrado con JWT_SECRET
    ]);
    const entrar = async () =>
      (await pedir(ctx, '/api/v1/superadmin/login', { method: 'POST', body: { correo: 'rota@plataforma.co', clave, codigo: codigoTotp(secreto) } })).estado;
    assert.equal(await entrar(), 401);

    const r = await recifrarSegundosPasos(ctx.pool, { antigua: SECRETO_PRUEBAS, nueva: NUEVA });
    assert.deepEqual(r, { recifradas: 1, yaActualizadas: 0, ilegibles: [] });
    assert.equal(await entrar(), 200, 'misma clave de la app autenticadora, sin QR nuevo');

    // Repetirlo no hace daño
    assert.deepEqual(await recifrarSegundosPasos(ctx.pool, { antigua: SECRETO_PRUEBAS, nueva: NUEVA }), { recifradas: 0, yaActualizadas: 1, ilegibles: [] });
  });

  test('avisa de las claves que no se pueden leer con ninguna llave', async () => {
    await ctx.pool.query('INSERT INTO superadmins (correo, password_hash, totp_secreto) VALUES ($1, $2, $3)', [
      'perdida@plataforma.co',
      await cifrarContrasena('Super-admin-123!'),
      cifrarSecreto(generarSecretoTotp(), 'otra-llave-que-ya-no-existe-1234567890'),
    ]);
    const r = await recifrarSegundosPasos(ctx.pool, { antigua: SECRETO_PRUEBAS, nueva: NUEVA });
    assert.deepEqual(r.ilegibles, ['perdida@plataforma.co']);
  });
});
