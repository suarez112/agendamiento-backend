import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { crearServicioIntentos } from '../src/modules/auth/intentos.js';
import { codigoTotp, cifrarSecreto, generarSecretoTotp } from '../src/modules/superadmin/totp.js';
import { cifrarContrasena } from '../src/modules/auth/contrasenas.js';
import {
  CLAVE_CLIENTE,
  type Contexto,
  iniciar,
  pedir,
  registrarCliente,
  SECRETO_TOTP_PRUEBAS,
} from './apoyo/servidor.js';

const MENSAJE_BLOQUEO = 'Demasiados intentos de inicio de sesión. Intenta de nuevo en unos minutos.';

const loginUnico = (ctx: Contexto, usuario: string, clave: string, headers?: Record<string, string>) =>
  pedir(ctx, '/api/v1/login', { method: 'POST', body: { usuario, clave }, headers });
const loginPersonal = (ctx: Contexto, usuario: string, clave: string) =>
  pedir(ctx, '/api/v1/auth/login', { method: 'POST', body: { usuario, clave } });
const loginCuentas = (ctx: Contexto, correo: string, clave: string) =>
  pedir(ctx, '/api/v1/cuentas/login', { method: 'POST', body: { correo, clave } });

// M-1 — cada ruta de inicio de sesión tiene su propio límite por IP
describe('límites de intentos separados por ruta', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar({ limites: { loginUnico: 2, loginPersonal: 2, loginCuentas: 2 } });
  });
  after(() => ctx.cerrar());

  test('agotar el límite de una ruta no bloquea las demás', async () => {
    assert.equal((await loginUnico(ctx, 'nadie1', 'mal')).estado, 401);
    assert.equal((await loginUnico(ctx, 'nadie2', 'mal')).estado, 401);
    const bloqueada = await loginUnico(ctx, 'nadie3', 'mal');
    assert.equal(bloqueada.estado, 429);
    assert.deepEqual(bloqueada.json, { error: MENSAJE_BLOQUEO });

    // Las otras rutas tienen su propio contador: siguen respondiendo 401 (no 429)
    assert.equal((await loginPersonal(ctx, 'nadie1', 'mal')).estado, 401);
    assert.equal((await loginCuentas(ctx, 'nadie@correo.com', 'mal')).estado, 401);
    assert.equal((await loginPersonal(ctx, 'nadie2', 'mal')).estado, 401);
    assert.equal((await loginPersonal(ctx, 'nadie3', 'mal')).estado, 429);
    assert.equal((await loginCuentas(ctx, 'nadie@correo.com', 'mal')).estado, 401);
    assert.equal((await loginCuentas(ctx, 'nadie@correo.com', 'mal')).estado, 429);
  });

  test('eliminar la cuenta y el panel del superadmin tienen su propio contador', async () => {
    const registro = await registrarCliente(ctx, 'propio@correo.com', CLAVE_CLIENTE);
    assert.equal(registro.estado, 201, registro.texto);
    const token = registro.json.token as string;
    // El límite del login ya se agotó para esta IP, pero eliminar la cuenta cuenta aparte
    const eliminar = await pedir(ctx, '/api/v1/cuentas/eliminar', { method: 'POST', token, body: { clave: 'mal' } });
    assert.equal(eliminar.estado, 401);
    const panel = await pedir(ctx, '/api/v1/superadmin/login', {
      method: 'POST',
      body: { correo: 'x@y.co', clave: 'mal', codigo: '000000' },
    });
    assert.equal(panel.estado, 401);
  });
});

// M-1 — contador por cuenta, guardado en la base de datos
describe('contador de intentos por cuenta (en la base de datos)', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar({ limites: { fallosPorCuenta: 3, bloqueoCuentaMs: 60_000 } });
  });
  after(() => ctx.cerrar());

  const filas = async () => (await ctx.pool.query('SELECT * FROM intentos_login ORDER BY clave')).rows;
  const limpiar = () => ctx.pool.query('DELETE FROM intentos_login');

  test('tras 3 fallos la cuenta se bloquea en todas las rutas, aun con la contraseña correcta', async () => {
    await limpiar();
    for (let i = 0; i < 3; i++) assert.equal((await loginPersonal(ctx, 'admin.a', 'mal')).estado, 401);
    // El bloqueo es de la cuenta, no de la ruta: tampoco entra por el login único ni con otras mayúsculas
    for (const r of [await loginUnico(ctx, 'admin.a', '1234'), await loginUnico(ctx, 'ADMIN.A', '1234'), await loginPersonal(ctx, 'admin.a', '1234')]) {
      assert.equal(r.estado, 429);
      assert.deepEqual(r.json, { error: MENSAJE_BLOQUEO });
    }
    // Otras cuentas no se ven afectadas
    assert.equal((await loginPersonal(ctx, 'admin.b', 'clave-b')).estado, 200);
  });

  test('no se guarda el correo ni el usuario: solo un hash', async () => {
    const claves = (await filas()).map((f) => f.clave as string);
    assert.ok(claves.length > 0);
    for (const clave of claves) assert.match(clave, /^cuenta:[0-9a-f]{64}$/);
    assert.ok(!claves.some((c) => c.includes('admin')));
  });

  test('un identificador que no existe se cuenta igual: la respuesta no revela qué cuentas hay', async () => {
    await limpiar();
    const estados: number[] = [];
    for (let i = 0; i < 4; i++) estados.push((await loginUnico(ctx, 'no.existe', 'mal')).estado);
    assert.deepEqual(estados, [401, 401, 401, 429]);
    const real = [];
    for (let i = 0; i < 4; i++) real.push((await loginCuentas(ctx, 'nadie@correo.com', 'mal')).estado);
    assert.deepEqual(real, [401, 401, 401, 429]);
    // Y el mensaje de bloqueo es idéntico para una cuenta que existe
    for (let i = 0; i < 3; i++) await loginUnico(ctx, 'admin.a', 'mal');
    const inexistente = await loginUnico(ctx, 'no.existe', 'mal');
    const existente = await loginUnico(ctx, 'admin.a', 'mal');
    assert.deepEqual([inexistente.estado, existente.estado], [429, 429]);
    assert.deepEqual(inexistente.json, existente.json);
  });

  test('un inicio de sesión correcto reinicia el contador', async () => {
    await limpiar();
    for (let i = 0; i < 2; i++) assert.equal((await loginPersonal(ctx, 'barbero.a', 'mal')).estado, 401);
    assert.equal((await loginPersonal(ctx, 'barbero.a', 'clave-a')).estado, 200);
    assert.deepEqual(await filas(), [], 'la fila se borró');
    for (let i = 0; i < 2; i++) assert.equal((await loginPersonal(ctx, 'barbero.a', 'mal')).estado, 401);
    assert.equal((await loginPersonal(ctx, 'barbero.a', 'clave-a')).estado, 200, 'dos fallos más no bloquean');
  });

  test('cuando pasa el bloqueo, la cuenta vuelve a entrar', async () => {
    await limpiar();
    for (let i = 0; i < 3; i++) await loginPersonal(ctx, 'barbero.a2', 'mal');
    assert.equal((await loginPersonal(ctx, 'barbero.a2', 'secreta')).estado, 429);
    await ctx.pool.query("UPDATE intentos_login SET bloqueado_hasta = now() - interval '1 second'");
    assert.equal((await loginPersonal(ctx, 'barbero.a2', 'secreta')).estado, 200);
  });

  test('eliminar la cuenta: la contraseña errónea tiene su contador y no bloquea el inicio de sesión', async () => {
    await limpiar();
    const registro = await registrarCliente(ctx, 'borrar@correo.com', CLAVE_CLIENTE);
    const token = registro.json.token as string;
    const eliminar = (clave: string) => pedir(ctx, '/api/v1/cuentas/eliminar', { method: 'POST', token, body: { clave } });
    for (let i = 0; i < 3; i++) assert.equal((await eliminar('mal')).estado, 401);
    assert.equal((await eliminar(CLAVE_CLIENTE)).estado, 429, 'ni con la contraseña correcta mientras está bloqueado');
    assert.equal((await loginCuentas(ctx, 'borrar@correo.com', CLAVE_CLIENTE)).estado, 200, 'el login es otro contador');
  });

  test('el contador sobrevive a un reinicio: otra instancia del servicio ve el mismo estado', async () => {
    await limpiar();
    const config = { max: 2, ventanaMs: 60_000, bloqueoBaseMs: 1_000, bloqueoMaxMs: 4_000 };
    const antes = crearServicioIntentos(ctx.pool, config);
    const clave = antes.claveDe('cuenta', 'Persona@Correo.com');
    assert.equal(await antes.registrarFallo(clave), 1);
    const despues = crearServicioIntentos(ctx.pool, config); // como tras reiniciar el servidor
    assert.equal(await despues.registrarFallo(clave), 2, 'sigue contando desde el fallo anterior');
    await assert.rejects(despues.exigirSinBloqueo(clave), { estado: 429 });
    await assert.rejects(antes.exigirSinBloqueo(antes.claveDe('cuenta', 'persona@correo.com')), { estado: 429 }, 'sin distinguir mayúsculas');
  });

  test('cada bloqueo seguido dura el doble, con tope', async () => {
    await limpiar();
    const config = { max: 2, ventanaMs: 60_000, bloqueoBaseMs: 1_000, bloqueoMaxMs: 3_000 };
    const servicio = crearServicioIntentos(ctx.pool, config);
    const clave = servicio.claveDe('cuenta', 'escalada');
    const duracion = async () =>
      Number((await ctx.pool.query('SELECT extract(epoch from (bloqueado_hasta - now())) * 1000 AS ms FROM intentos_login WHERE clave = $1', [clave])).rows[0].ms);
    const liberar = () => ctx.pool.query("UPDATE intentos_login SET bloqueado_hasta = now() - interval '1 second' WHERE clave = $1", [clave]);

    await servicio.registrarFallo(clave);
    await servicio.registrarFallo(clave);
    const primero = await duracion();
    await liberar();
    await servicio.registrarFallo(clave);
    await servicio.registrarFallo(clave);
    const segundo = await duracion();
    await liberar();
    await servicio.registrarFallo(clave);
    await servicio.registrarFallo(clave);
    const tercero = await duracion();

    assert.ok(primero > 0 && primero <= 1_000, `primero=${primero}`);
    assert.ok(segundo > 1_000 && segundo <= 2_000, `segundo=${segundo}`);
    assert.ok(tercero > 2_000 && tercero <= 3_000, `tercero=${tercero} (tope 3 s en lugar de 4 s)`);
  });

  test('las filas viejas se limpian solas', async () => {
    await limpiar();
    await ctx.pool.query("INSERT INTO intentos_login (clave, intentos, actualizado_en) VALUES ('cuenta:vieja', 1, now() - interval '3 days')");
    await loginPersonal(ctx, 'barbero.a', 'mal');
    const claves = (await filas()).map((f) => f.clave);
    assert.ok(!claves.includes('cuenta:vieja'));
  });

  test('un fallo queda en el registro del servidor, sin la contraseña ni el usuario', async () => {
    await limpiar();
    const entorno = process.env.NODE_ENV;
    const original = console.log;
    const lineas: string[] = [];
    process.env.NODE_ENV = 'development'; // en las pruebas el registro de avisos está apagado
    console.log = (...partes: unknown[]) => void lineas.push(partes.join(' '));
    try {
      await loginUnico(ctx, 'barbero.a', 'contrasena-secreta-que-no-debe-salir');
    } finally {
      console.log = original;
      process.env.NODE_ENV = entorno;
    }
    const fallo = lineas.map((l) => JSON.parse(l)).find((l) => l.evento === 'login_fallido');
    assert.ok(fallo, lineas.join('\n'));
    assert.equal(fallo.ruta, '/login');
    assert.ok(['127.0.0.1', '::1'].includes(fallo.ip));
    assert.equal(fallo.fallosSeguidos, 1);
    const texto = lineas.join('\n');
    assert.ok(!texto.includes('contrasena-secreta'), 'sin la contraseña');
    assert.ok(!texto.includes('barbero.a'), 'sin el usuario (solo un hash corto de la cuenta)');
  });
});

// M-5 — el bloqueo del superadmin es por cuenta + IP
describe('bloqueo del superadmin por cuenta y por IP', () => {
  let ctx: Contexto;
  const CORREO = 'dueno@plataforma.co';
  const CLAVE = 'Super-admin-123!';
  const secreto = generarSecretoTotp();
  const IP_ATACANTE = '203.0.113.5';
  const IP_DUENO = '198.51.100.7';

  before(async () => {
    ctx = await iniciar({ entorno: { TRUST_PROXY: 1 }, limites: { fallosSuperadmin: 3 } });
    await ctx.pool.query('INSERT INTO superadmins (correo, password_hash, totp_secreto) VALUES ($1, $2, $3)', [
      CORREO,
      await cifrarContrasena(CLAVE),
      cifrarSecreto(secreto, SECRETO_TOTP_PRUEBAS),
    ]);
  });
  after(() => ctx.cerrar());

  const entrar = (ip: string, cambios: { correo?: string; clave?: string } = {}) =>
    pedir(ctx, '/api/v1/superadmin/login', {
      method: 'POST',
      body: { correo: CORREO, clave: CLAVE, codigo: codigoTotp(secreto), ...cambios },
      headers: { 'X-Forwarded-For': ip },
    });

  test('quien conoce el correo no puede dejar fuera al dueño: el bloqueo es de su propia IP', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await entrar(IP_ATACANTE, { clave: 'mal' })).estado, 401);
    // El atacante queda bloqueado, aun con las credenciales correctas
    const bloqueado = await entrar(IP_ATACANTE);
    assert.equal(bloqueado.estado, 429);
    // El dueño, desde otra IP, entra sin problema
    const dueno = await entrar(IP_DUENO);
    assert.equal(dueno.estado, 200, dueno.texto);
    // La cuenta no quedó bloqueada en la base
    const { rows } = await ctx.pool.query('SELECT intentos_fallidos, bloqueado_hasta FROM superadmins');
    assert.deepEqual(rows, [{ intentos_fallidos: 0, bloqueado_hasta: null }]);
  });

  test('el mensaje de bloqueo es el mismo exista o no la cuenta', async () => {
    const ip = '203.0.113.77';
    for (let i = 0; i < 3; i++) assert.equal((await entrar(ip, { correo: 'no.existe@plataforma.co', clave: 'mal' })).estado, 401);
    const inexistente = await entrar(ip, { correo: 'no.existe@plataforma.co' });
    for (let i = 0; i < 3; i++) assert.equal((await entrar('203.0.113.78', { clave: 'mal' })).estado, 401);
    const existente = await entrar('203.0.113.78');
    assert.equal(inexistente.estado, 429);
    assert.equal(existente.estado, 429);
    assert.deepEqual(inexistente.json, existente.json);
    assert.deepEqual(existente.json, { error: MENSAJE_BLOQUEO });
  });

  test('el dueño que se equivoca tiene su propio contador y se recupera al acertar', async () => {
    await ctx.pool.query('UPDATE superadmins SET totp_ultimo_paso = NULL');
    assert.equal((await entrar(IP_DUENO, { clave: 'mal' })).estado, 401);
    assert.equal((await entrar(IP_DUENO, { clave: 'mal' })).estado, 401);
    assert.equal((await entrar(IP_DUENO)).estado, 200);
    await ctx.pool.query('UPDATE superadmins SET totp_ultimo_paso = NULL');
    for (let i = 0; i < 2; i++) assert.equal((await entrar(IP_DUENO, { clave: 'mal' })).estado, 401);
    assert.equal((await entrar(IP_DUENO)).estado, 200, 'acertar reinició el contador');
  });
});
