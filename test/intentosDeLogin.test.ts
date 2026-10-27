import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { conContadorDeCuenta, crearServicioIntentos } from '../src/modules/auth/intentos.js';
import { crearServicioRecuperacion } from '../src/modules/cuentas/recuperacion.servicio.js';
import { codigoTotp, cifrarSecreto, generarSecretoTotp } from '../src/modules/superadmin/totp.js';
import { cifrarContrasena } from '../src/modules/auth/contrasenas.js';
import {
  CLAVE_CLIENTE,
  type Contexto,
  iniciar,
  pedir,
  registrarCliente,
  esperarHasta,
  SECRETO_RECUPERACION_PRUEBAS,
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

  test('si falla el borrado del contador tras un inicio correcto, la persona entra y el fallo se registra', async () => {
    await limpiar();
    const servicio = crearServicioIntentos(ctx.pool, { max: 3, ventanaMs: 60_000, bloqueoBaseMs: 1_000, bloqueoMaxMs: 4_000 });
    const roto = { ...servicio, limpiar: async () => Promise.reject(new Error('base caída')) };
    const original = console.error;
    const lineas: string[] = [];
    console.error = (...partes: unknown[]) => void lineas.push(partes.join(' '));
    try {
      const resultado = await conContadorDeCuenta(roto, servicio.claveDe('cuenta', 'entra'), { ruta: '/login', ip: null }, async () => 'dentro');
      assert.equal(resultado, 'dentro');
    } finally {
      console.error = original;
    }
    const evento = lineas.map((l) => JSON.parse(l)).find((l) => l.evento === 'intentos_login_fallo');
    assert.ok(evento, lineas.join(' | '));
    assert.match(evento.mensaje, /base caída/);
  });

  test('si falla la comprobación extra del bloqueo tras una contraseña correcta, no da 500: responde 429 y se registra', async () => {
    await limpiar();
    const servicio = crearServicioIntentos(ctx.pool, { max: 3, ventanaMs: 60_000, bloqueoBaseMs: 1_000, bloqueoMaxMs: 4_000 });
    let llamadas = 0;
    let reiniciado = false;
    const roto = {
      ...servicio,
      // La primera comprobación (antes de probar la contraseña) funciona; la segunda (después) falla
      exigirSinBloqueo: async () => {
        if (++llamadas === 2) throw new Error('base caída');
      },
      limpiar: async () => void (reiniciado = true),
    };
    const original = console.error;
    const lineas: string[] = [];
    console.error = (...partes: unknown[]) => void lineas.push(partes.join(' '));
    try {
      await assert.rejects(conContadorDeCuenta(roto, servicio.claveDe('cuenta', 'duda'), { ruta: '/login', ip: null }, async () => 'dentro'), {
        estado: 429,
        message: MENSAJE_BLOQUEO,
      });
    } finally {
      console.error = original;
    }
    assert.equal(reiniciado, false, 'sin saber si estaba bloqueada, no se reinicia nada');
    const evento = lineas.map((l) => JSON.parse(l)).find((l) => l.evento === 'intentos_login_fallo');
    assert.ok(evento, lineas.join(' | '));
    assert.match(evento.mensaje, /base caída/);
  });

  test('al recuperar la contraseña con el código se quita el bloqueo de la cuenta, por correo, por usuario y al eliminarla', async () => {
    await limpiar();
    const correo = 'recupera.bloqueada@correo.com';
    const registro = await registrarCliente(ctx, correo, CLAVE_CLIENTE);
    assert.equal(registro.estado, 201, registro.texto);
    const token = registro.json.token as string;
    await ctx.pool.query("UPDATE usuarios SET usuario = 'recupera.usuario' WHERE lower(correo) = $1", [correo]);
    const eliminar = (clave: string) => pedir(ctx, '/api/v1/cuentas/eliminar', { method: 'POST', token, body: { clave } });
    const bloquear = async () => {
      for (let i = 0; i < 3; i++) {
        assert.equal((await loginCuentas(ctx, correo, 'mal')).estado, 401);
        assert.equal((await loginUnico(ctx, 'recupera.usuario', 'mal')).estado, 401);
        assert.equal((await eliminar('mal')).estado, 401);
      }
      assert.equal((await loginCuentas(ctx, correo, CLAVE_CLIENTE)).estado, 429);
      assert.equal((await loginUnico(ctx, 'recupera.usuario', CLAVE_CLIENTE)).estado, 429);
    };
    await bloquear();

    let texto = '';
    const recuperacion = crearServicioRecuperacion({
      pool: ctx.pool,
      secreto: SECRETO_RECUPERACION_PRUEBAS,
      correo: { enviar: async (m: { texto: string }) => void (texto = m.texto) },
      intentos: crearServicioIntentos(ctx.pool, { max: 3, ventanaMs: 60_000, bloqueoBaseMs: 60_000, bloqueoMaxMs: 240_000 }),
    });
    await recuperacion.solicitar(correo);
    const codigo = (await esperarHasta(async () => texto.match(/\b(\d{6})\b/)))[1];

    // Un código equivocado no desbloquea nada
    const equivocado = codigo === '000000' ? '000001' : '000000';
    await assert.rejects(recuperacion.restablecer({ correo, codigo: equivocado, clave: 'Nueva-clave-9!' }), { estado: 400 });
    assert.equal((await filas()).length, 3, 'siguen las tres cuentas bloqueadas');

    await recuperacion.restablecer({ correo, codigo, clave: 'Nueva-clave-9!' });
    assert.deepEqual(await filas(), [], 'se reiniciaron los tres contadores');
    assert.equal((await loginCuentas(ctx, correo, 'Nueva-clave-9!')).estado, 200);
    assert.equal((await loginUnico(ctx, 'recupera.usuario', 'Nueva-clave-9!')).estado, 200);
    // Otras cuentas bloqueadas siguen bloqueadas
    for (let i = 0; i < 3; i++) await loginPersonal(ctx, 'barbero.a', 'mal');
    assert.equal((await loginPersonal(ctx, 'barbero.a', 'clave-a')).estado, 429);
  });

  test('varios fallos simultáneos se cuentan todos y producen un solo bloqueo', async () => {
    await limpiar();
    const servicio = crearServicioIntentos(ctx.pool, { max: 3, ventanaMs: 60_000, bloqueoBaseMs: 60_000, bloqueoMaxMs: 240_000 });
    const clave = servicio.claveDe('cuenta', 'a.la.vez');
    const resultados = await Promise.all(Array.from({ length: 12 }, () => servicio.registrarFallo(clave)));
    assert.equal(resultados.length, 12);
    const [fila, ...otras] = await filas();
    assert.equal(otras.length, 0);
    assert.equal(fila.bloqueos, 1, 'el bloqueo se aplica una vez: los fallos que llegan con la cuenta bloqueada no cambian nada');
    assert.equal(fila.intentos, 0);
    assert.ok(fila.bloqueado_hasta > new Date());
    await assert.rejects(servicio.exigirSinBloqueo(clave), { estado: 429 });

    // Con contraseñas incorrectas en paralelo por HTTP pasa lo mismo, y la correcta ya no entra
    await limpiar();
    const intentos = await Promise.all(Array.from({ length: 8 }, () => loginPersonal(ctx, 'barbero.a', 'mal')));
    assert.ok(intentos.every((r) => r.estado === 401 || r.estado === 429));
    assert.equal(intentos.filter((r) => r.estado === 401).length >= 3, true, 'los tres primeros fallos cuentan');
    assert.equal((await filas())[0].bloqueos, 1);
    assert.equal((await loginPersonal(ctx, 'barbero.a', 'clave-a')).estado, 429);
  });

  test('una contraseña correcta que termina de probarse con la cuenta ya bloqueada no entra', async () => {
    await limpiar();
    const servicio = crearServicioIntentos(ctx.pool, { max: 2, ventanaMs: 60_000, bloqueoBaseMs: 60_000, bloqueoMaxMs: 240_000 });
    const clave = servicio.claveDe('cuenta', 'carrera');
    await assert.rejects(
      conContadorDeCuenta(servicio, clave, { ruta: '/login', ip: null }, async () => {
        // Mientras se comprueba la contraseña, otros intentos fallidos bloquean la cuenta
        await Promise.all([servicio.registrarFallo(clave), servicio.registrarFallo(clave)]);
        return 'dentro';
      }),
      { estado: 429 },
    );
    assert.equal((await filas()).length, 1, 'el bloqueo sigue en pie: no se reinició el contador');
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
