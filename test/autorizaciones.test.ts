import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fechaEnDias } from './apoyo/baseDePrueba.js';
import {
  CLAVE_ADMIN,
  CLAVE_CLIENTE,
  type Contexto,
  crearSuperadmin,
  iniciar,
  iniciarSesion,
  iniciarSesionCuenta,
  pedir,
  registrarCliente,
  registrarEmpresa,
  reservaValida,
  SECRETO_PRUEBAS,
  SECRETO_RECUPERACION_PRUEBAS,
  SECRETO_TOTP_PRUEBAS,
} from './apoyo/servidor.js';
import { cargarEntorno } from '../src/config/entorno.js';

const DEBE_ACEPTAR = 'Debes aceptar la Política de Tratamiento de Datos y los Términos y Condiciones';
const NUEVA_VERSION =
  'Publicamos una nueva versión de la Política de Tratamiento de Datos o de los Términos y Condiciones. Acéptala para continuar.';

// Ley 1581 de 2012: la prueba de cada autorización no se puede alterar y cada aceptación guarda lo necesario
describe('prueba de las autorizaciones', () => {
  let ctx: Contexto;
  const consulta = async (sql: string, valores: unknown[] = []) => (await ctx.pool.query(sql, valores)).rows;
  const reservar = (cambios: Record<string, unknown>, token?: string, headers?: Record<string, string>) =>
    pedir(ctx, '/api/v1/citas', { method: 'POST', body: reservaValida(cambios), token, headers });

  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  test('la auditoría es solo de inserción: no se puede modificar, borrar ni vaciar', async () => {
    const r = await reservar({ fecha: fechaEnDias(2), telefono: '3100000020' });
    assert.equal(r.estado, 201, r.texto);
    const antes = await consulta('SELECT id, telefono, canal, version_politica, ip FROM auditoria_autorizaciones ORDER BY id');
    assert.ok(antes.length > 0);

    for (const sql of [
      "UPDATE auditoria_autorizaciones SET version_politica = '0.0'",
      "UPDATE auditoria_autorizaciones SET ip = '1.1.1.1', telefono = NULL",
      'DELETE FROM auditoria_autorizaciones',
      'TRUNCATE auditoria_autorizaciones',
    ]) {
      await assert.rejects(ctx.pool.query(sql), /solo de inserción/, sql);
    }
    assert.deepEqual(await consulta('SELECT id, telefono, canal, version_politica, ip FROM auditoria_autorizaciones ORDER BY id'), antes);
    // Agregar filas nuevas sí se puede
    await ctx.pool.query("INSERT INTO auditoria_autorizaciones (telefono, canal, version_politica, version_terminos) VALUES ('+573100000021', 'reserva_invitado', '1.0', '1.0')");
  });

  test('el registro de actividad del superadmin tampoco se puede modificar ni borrar', async () => {
    await crearSuperadmin(ctx); // el inicio de sesión queda registrado
    const antes = await consulta('SELECT id, accion, superadmin_correo FROM actividad_superadmin ORDER BY id');
    assert.ok(antes.some((a) => a.accion === 'inicio_sesion'));
    for (const sql of [
      "UPDATE actividad_superadmin SET accion = 'otra'",
      'DELETE FROM actividad_superadmin',
      'TRUNCATE actividad_superadmin',
    ]) {
      await assert.rejects(ctx.pool.query(sql), /no se puede modificar ni borrar/, sql);
    }
    assert.deepEqual(await consulta('SELECT id, accion, superadmin_correo FROM actividad_superadmin ORDER BY id'), antes);
  });

  test('una reserva de invitado sin aceptar no crea nada; aceptando guarda la prueba con el teléfono y la cita', async () => {
    const conteo = async () => (await consulta('SELECT (SELECT count(*)::int FROM citas) AS citas, (SELECT count(*)::int FROM clientes) AS clientes, (SELECT count(*)::int FROM auditoria_autorizaciones) AS pruebas'))[0];
    const antes = await conteo();
    for (const cambios of [{ aceptaPoliticaDatos: false }, { aceptaTerminos: false }, { aceptaPoliticaDatos: undefined, aceptaTerminos: undefined }]) {
      const r = await reservar({ fecha: fechaEnDias(3), telefono: '3100000022', ...cambios });
      assert.equal(r.estado, 400, JSON.stringify(cambios));
      assert.deepEqual(r.json, { error: DEBE_ACEPTAR });
    }
    assert.deepEqual(await conteo(), antes);

    const ok = await reservar({ fecha: fechaEnDias(3), telefono: '310 000 0022', nombre: 'Invitada' });
    assert.equal(ok.estado, 201, ok.texto);
    const filas = await consulta('SELECT * FROM auditoria_autorizaciones WHERE cita_id = $1', [ok.json.cita.id]);
    assert.equal(filas.length, 1);
    assert.deepEqual(
      {
        canal: filas[0].canal,
        telefono: filas[0].telefono,
        indicativo: filas[0].indicativo,
        empresa_id: filas[0].empresa_id,
        usuario_id: filas[0].usuario_id,
        version_politica: filas[0].version_politica,
        version_terminos: filas[0].version_terminos,
      },
      {
        canal: 'reserva_invitado',
        telefono: '+573100000022',
        indicativo: '57',
        empresa_id: 'emp_a',
        usuario_id: null,
        version_politica: '1.0',
        version_terminos: '1.0',
      },
    );
    assert.ok(filas[0].ip && filas[0].user_agent && filas[0].aceptado_en);
  });

  test('IP y navegador salen de la petición, nunca del cuerpo que envía la app', async () => {
    const r = await pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      body: { ...reservaValida({ fecha: fechaEnDias(3), hora: '11:00 AM', telefono: '3100000023' }), ip: '9.9.9.9', userAgent: 'falso', user_agent: 'falso' },
      headers: { 'User-Agent': 'AgendaYa-Prueba/1.0' },
    });
    assert.equal(r.estado, 201, r.texto);
    const [fila] = await consulta('SELECT ip, user_agent FROM auditoria_autorizaciones WHERE cita_id = $1', [r.json.cita.id]);
    assert.equal(fila.user_agent, 'AgendaYa-Prueba/1.0');
    assert.ok(['127.0.0.1', '::1'].includes(fila.ip), `ip=${fila.ip}`);
  });

  test('el navegador se recorta a 500 caracteres', async () => {
    const r = await reservar({ fecha: fechaEnDias(3), hora: '12:00 PM', telefono: '3100000024' }, undefined, { 'User-Agent': 'a'.repeat(900) });
    assert.equal(r.estado, 201, r.texto);
    const [fila] = await consulta('SELECT user_agent FROM auditoria_autorizaciones WHERE cita_id = $1', [r.json.cita.id]);
    assert.equal(fila.user_agent.length, 500);
  });

  test('cuando se publica una versión nueva, el cliente con cuenta debe aceptarla y queda la prueba', async () => {
    const registro = await registrarCliente(ctx, 'version@correo.com', CLAVE_CLIENTE);
    assert.equal(registro.estado, 201);
    const token = registro.json.token;
    const usuarioId = registro.json.usuario.id;
    const estado = () => pedir(ctx, '/api/v1/legal/estado', { token });
    assert.equal((await estado()).json.vigente, true, 'aceptó la versión vigente al registrarse');

    await ctx.pool.query(
      `INSERT INTO documentos_legales (tipo, version, titulo, contenido) VALUES
         ('politica_datos', '2.0', 'Política 2.0', 'texto'), ('terminos', '2.0', 'Términos 2.0', 'texto')`,
    );
    const nueva = await estado();
    assert.deepEqual([nueva.json.vigente, nueva.json.versionPolitica, nueva.json.versionTerminos], [false, '2.0', '2.0']);
    assert.equal((await iniciarSesionCuenta(ctx, 'version@correo.com', CLAVE_CLIENTE)).json.debeAceptarDocumentos, true);

    const fecha = fechaEnDias(4);
    const sinAceptar = await pedir(ctx, '/api/v1/citas', { method: 'POST', token, body: reservaValida({ fecha, aceptaPoliticaDatos: undefined, aceptaTerminos: undefined }) });
    assert.equal(sinAceptar.estado, 400);
    assert.deepEqual(sinAceptar.json, { error: NUEVA_VERSION });

    const aceptando = await pedir(ctx, '/api/v1/citas', { method: 'POST', token, body: reservaValida({ fecha }) });
    assert.equal(aceptando.estado, 201, aceptando.texto);
    const pruebas = await consulta('SELECT canal, version_politica, version_terminos FROM auditoria_autorizaciones WHERE usuario_id = $1 ORDER BY id', [usuarioId]);
    assert.deepEqual(pruebas, [
      { canal: 'registro_cliente', version_politica: '1.0', version_terminos: '1.0' },
      { canal: 'nueva_version', version_politica: '2.0', version_terminos: '2.0' },
    ]);
    assert.equal((await estado()).json.vigente, true);

    // Ya aceptó: la siguiente reserva no exige volver a aceptar ni guarda otra prueba
    const otra = await pedir(ctx, '/api/v1/citas', { method: 'POST', token, body: reservaValida({ fecha, hora: '03:00 PM', aceptaPoliticaDatos: undefined, aceptaTerminos: undefined }) });
    assert.equal(otra.estado, 201, otra.texto);
    assert.equal((await consulta('SELECT count(*)::int AS n FROM auditoria_autorizaciones WHERE usuario_id = $1', [usuarioId]))[0].n, 2);
  });

  test('cualquier sesión puede aceptar la versión vigente; repetirlo no agrega otra fila', async () => {
    const token = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    const sin = await pedir(ctx, '/api/v1/legal/aceptar', { method: 'POST', token, body: { aceptaPoliticaDatos: true } });
    assert.equal(sin.estado, 400);
    assert.deepEqual(sin.json, { error: DEBE_ACEPTAR });
    const estadoAntes = await pedir(ctx, '/api/v1/legal/estado', { token });
    assert.deepEqual([estadoAntes.json.vigente, estadoAntes.json.ultimaAceptacion], [false, null]);

    const primera = await pedir(ctx, '/api/v1/legal/aceptar', { method: 'POST', token, body: { aceptaPoliticaDatos: true, aceptaTerminos: true } });
    assert.equal(primera.estado, 201, primera.texto);
    assert.equal(primera.json.mensaje, 'Aceptación registrada');
    assert.equal(primera.json.vigente, true);
    const segunda = await pedir(ctx, '/api/v1/legal/aceptar', { method: 'POST', token, body: { aceptaPoliticaDatos: true, aceptaTerminos: true } });
    assert.equal(segunda.estado, 200);
    assert.equal(segunda.json.mensaje, 'Ya aceptaste las versiones vigentes');
    const filas = await consulta("SELECT canal, version_politica FROM auditoria_autorizaciones WHERE barbero_id = 'barb_a'");
    assert.deepEqual(filas, [{ canal: 'nueva_version', version_politica: '2.0' }]);
    assert.equal((await pedir(ctx, '/api/v1/legal/estado')).estado, 401);
  });
});

// TRUST_PROXY: de dónde se lee la IP, que sirve para la prueba legal y para los límites de intentos
describe('lectura de la IP según TRUST_PROXY', () => {
  const ipDeLaPrueba = async (ctx: Contexto, headers: Record<string, string>, telefono: string, hora = '10:00 AM') => {
    const r = await pedir(ctx, '/api/v1/citas', { method: 'POST', body: reservaValida({ fecha: fechaEnDias(2), hora, telefono }), headers });
    assert.equal(r.estado, 201, r.texto);
    return (await ctx.pool.query('SELECT ip FROM auditoria_autorizaciones WHERE cita_id = $1', [r.json.cita.id])).rows[0].ip as string;
  };

  test('sin proxy de confianza (TRUST_PROXY=0) se ignoran X-Forwarded-For y CF-Connecting-IP, que cualquiera puede escribir', async () => {
    const ctx = await iniciar({ entorno: { TRUST_PROXY: 0 } });
    try {
      const ip = await ipDeLaPrueba(ctx, { 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': '198.51.100.7' }, '3100000030');
      assert.ok(['127.0.0.1', '::1'].includes(ip), `ip=${ip}`);
    } finally {
      await ctx.cerrar();
    }
  });

  test('con un proxy de confianza (TRUST_PROXY=1) se usa la IP que informa el proxy, pero CF-Connecting-IP se ignora (M-2)', async () => {
    const ctx = await iniciar({ entorno: { TRUST_PROXY: 1 } });
    try {
      assert.equal(await ipDeLaPrueba(ctx, { 'X-Forwarded-For': '203.0.113.9' }, '3100000031'), '203.0.113.9');
      // Sin declarar Cloudflare, cualquiera puede escribir CF-Connecting-IP: no se usa
      assert.equal(
        await ipDeLaPrueba(ctx, { 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': '198.51.100.7' }, '3100000032', '11:00 AM'),
        '203.0.113.9',
      );
    } finally {
      await ctx.cerrar();
    }
  });

  test('con DETRAS_DE_CLOUDFLARE=true se usa CF-Connecting-IP; si no es una IP válida, la del proxy', async () => {
    const ctx = await iniciar({ entorno: { TRUST_PROXY: 1, DETRAS_DE_CLOUDFLARE: true } });
    try {
      assert.equal(await ipDeLaPrueba(ctx, { 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': '198.51.100.7' }, '3100000034'), '198.51.100.7');
      assert.equal(await ipDeLaPrueba(ctx, { 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': 'no-es-una-ip' }, '3100000035', '11:00 AM'), '203.0.113.9');
    } finally {
      await ctx.cerrar();
    }
  });

  test('DETRAS_DE_CLOUDFLARE sin proxy de confianza no hace que se crea el encabezado', async () => {
    const ctx = await iniciar({ entorno: { TRUST_PROXY: 0, DETRAS_DE_CLOUDFLARE: true } });
    try {
      const ip = await ipDeLaPrueba(ctx, { 'CF-Connecting-IP': '198.51.100.7' }, '3100000036');
      assert.ok(['127.0.0.1', '::1'].includes(ip), `ip=${ip}`);
    } finally {
      await ctx.cerrar();
    }
  });

  test('el valor por defecto de TRUST_PROXY es 0 y DETRAS_DE_CLOUDFLARE exige un proxy de confianza', () => {
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      JWT_SECRET: SECRETO_PRUEBAS,
      RECUPERACION_SECRET: SECRETO_RECUPERACION_PRUEBAS,
      TOTP_SECRET: SECRETO_TOTP_PRUEBAS,
      NODE_ENV: 'test',
    };
    delete base.TRUST_PROXY;
    delete base.DETRAS_DE_CLOUDFLARE;
    const porDefecto = cargarEntorno(base);
    assert.equal(porDefecto.TRUST_PROXY, 0);
    assert.equal(porDefecto.DETRAS_DE_CLOUDFLARE, false);
    assert.throws(() => cargarEntorno({ ...base, DETRAS_DE_CLOUDFLARE: 'true' }), /DETRAS_DE_CLOUDFLARE.*TRUST_PROXY/);
    assert.equal(cargarEntorno({ ...base, DETRAS_DE_CLOUDFLARE: 'true', TRUST_PROXY: '1' }).DETRAS_DE_CLOUDFLARE, true);
    assert.throws(() => cargarEntorno({ ...base, TRUST_PROXY: '-1' }), /TRUST_PROXY/);
    assert.throws(() => cargarEntorno({ ...base, TRUST_PROXY: '99' }), /TRUST_PROXY/);
  });

  test('el límite de intentos de login no se evita inventando X-Forwarded-For cuando no hay proxy de confianza', async () => {
    const ctx = await iniciar({ entorno: { TRUST_PROXY: 0 }, limites: { loginUnico: 3 } });
    try {
      const intentar = (ip: string) =>
        pedir(ctx, '/api/v1/login', { method: 'POST', body: { usuario: 'nadie', clave: 'x' }, headers: { 'X-Forwarded-For': ip, 'CF-Connecting-IP': ip } });
      const estados: number[] = [];
      for (let i = 0; i < 5; i++) estados.push((await intentar(`203.0.113.${i + 1}`)).estado);
      assert.deepEqual(estados, [401, 401, 401, 429, 429], 'aunque cada intento diga venir de otra IP');
    } finally {
      await ctx.cerrar();
    }
  });
});

// Ley 1581: eliminar la cuenta borra o anonimiza los datos personales
describe('eliminar la cuenta', () => {
  let ctx: Contexto;
  const consulta = async (sql: string, valores: unknown[] = []) => (await ctx.pool.query(sql, valores)).rows;
  const eliminar = (token: string, body: unknown) => pedir(ctx, '/api/v1/cuentas/eliminar', { method: 'POST', token, body });

  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  test('el cliente: se borra su cuenta y sus datos personales; las citas se conservan sin sus datos', async () => {
    const registro = await registrarCliente(ctx, 'borrar@correo.com', CLAVE_CLIENTE, { telefono: '3100000040', nombre: 'Cliente Que Se Va' });
    assert.equal(registro.estado, 201);
    const token = registro.json.token;
    const usuarioId = registro.json.usuario.id;
    const cita = await pedir(ctx, '/api/v1/citas', { method: 'POST', token, body: reservaValida({ fecha: fechaEnDias(3) }) });
    assert.equal(cita.estado, 201, cita.texto);
    const pqrs = await pedir(ctx, '/api/v1/pqrs', { method: 'POST', token, body: { tipo: 'queja', mensaje: 'Una queja' } });
    assert.equal(pqrs.estado, 201, pqrs.texto);
    assert.equal((await pedir(ctx, '/api/v1/dispositivos', { method: 'PUT', token, body: { token: 'ExponentPushToken[abc123]' } })).estado, 200);
    assert.equal((await pedir(ctx, '/api/v1/mi-cuenta/negocios', { method: 'POST', token, body: { codigo: 'NEGA' } })).estado, 201);

    // Con la contraseña equivocada no se borra nada
    const mal = await eliminar(token, { clave: 'No-es-la-clave1' });
    assert.equal(mal.estado, 401);
    assert.deepEqual(mal.json, { error: 'La contraseña no es correcta' });
    assert.equal((await consulta('SELECT count(*)::int AS n FROM usuarios WHERE id = $1', [usuarioId]))[0].n, 1);
    const sinClave = await eliminar(token, {});
    assert.equal(sinClave.estado, 400);

    const ok = await eliminar(token, { clave: CLAVE_CLIENTE });
    assert.equal(ok.estado, 200, ok.texto);
    assert.deepEqual(ok.json, { mensaje: 'Tu cuenta y tus datos personales fueron eliminados.' });

    // La cuenta y lo que colgaba de ella desaparecen
    assert.equal((await consulta('SELECT count(*)::int AS n FROM usuarios WHERE id = $1', [usuarioId]))[0].n, 0);
    assert.equal((await consulta('SELECT count(*)::int AS n FROM dispositivos_push WHERE usuario_id = $1', [usuarioId]))[0].n, 0);
    assert.equal((await consulta('SELECT count(*)::int AS n FROM negocios_guardados WHERE usuario_id = $1', [usuarioId]))[0].n, 0);
    // El cliente del negocio queda sin nombre ni teléfono reales
    const clientes = await consulta("SELECT nombre, telefono FROM clientes WHERE id = (SELECT cliente_id FROM citas WHERE id = $1)", [cita.json.cita.id]);
    assert.equal(clientes[0].nombre, 'Cliente eliminado');
    assert.ok(!clientes[0].telefono.startsWith('+'), 'el teléfono de relleno no es un número');
    assert.equal((await consulta("SELECT count(*)::int AS n FROM clientes WHERE telefono = '+573100000040'"))[0].n, 0);
    // La cita y la cartera se conservan, pero ya no apuntan a la cuenta
    assert.deepEqual(await consulta('SELECT estado, usuario_id FROM citas WHERE id = $1', [cita.json.cita.id]), [{ estado: 'CONFIRMADA', usuario_id: null }]);
    // La PQRS queda como registro de atención, sin nombre ni contacto
    const queja = await consulta('SELECT nombre, contacto, usuario_id FROM pqrs WHERE radicado = $1', [pqrs.json.pqrs.radicado]);
    assert.deepEqual(queja, [{ nombre: 'Cuenta eliminada', contacto: 'Cuenta eliminada', usuario_id: null }]);

    // La prueba de las autorizaciones se conserva a propósito (evidencia legal, solo de inserción)
    assert.equal((await consulta('SELECT count(*)::int AS n FROM auditoria_autorizaciones WHERE usuario_id = $1', [usuarioId]))[0].n, 1);

    // La sesión y la contraseña dejan de servir
    assert.equal((await pedir(ctx, '/api/v1/mi-cuenta/citas', { token })).estado, 401);
    assert.equal((await iniciarSesionCuenta(ctx, 'borrar@correo.com', CLAVE_CLIENTE)).estado, 401);
    // Otro cliente con otro teléfono no se tocó
    const otro = await registrarCliente(ctx, 'otro@correo.com', CLAVE_CLIENTE, { telefono: '3100000041', nombre: 'Se Queda' });
    assert.equal(otro.estado, 201);
  });

  test('la única administradora debe confirmar que cierra el negocio, y entonces se anonimiza y se cierra', async () => {
    const r = await registrarEmpresa(ctx, { correo: 'unica@central.co', codigoAcceso: 'CIERRE' });
    assert.equal(r.estado, 201, r.texto);
    const token = r.json.token;
    const empresaId = r.json.empresa.id;
    const servicio = await pedir(ctx, '/api/v1/servicios', { method: 'POST', token, body: { nombre: 'Corte', duracionMin: 30, precio: 20000 } });
    const pro = await pedir(ctx, '/api/v1/equipo', { method: 'POST', token, body: { nombre: 'Pro', usuario: 'pro.cierre', clave: 'Clave-segura-1' } });
    const cita = await pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      body: { empresaId, barberoId: pro.json.id, servicioId: servicio.json.id, fecha: fechaEnDias(2), hora: '10:00 AM', nombre: 'Cliente Del Negocio', telefono: '3100000050', aceptaPoliticaDatos: true, aceptaTerminos: true },
    });
    assert.equal(cita.estado, 201, cita.texto);
    const cliente = (await pedir(ctx, '/api/v1/clientes', { token })).json[0];
    assert.equal((await pedir(ctx, '/api/v1/clientes/lista-negra', { method: 'POST', token, body: { clienteId: cliente.id } })).estado, 201);

    const sinConfirmar = await eliminar(token, { clave: CLAVE_ADMIN });
    assert.equal(sinConfirmar.estado, 409);
    assert.equal(sinConfirmar.json.error, 'Eres la única persona que administra este negocio. Agrega primero a otro administrador en Equipo, o envía "eliminarNegocio": true para cerrar también el negocio.');
    assert.equal((await consulta('SELECT count(*)::int AS n FROM usuarios WHERE empresa_id = $1', [empresaId]))[0].n, 1, 'no se borró nada');

    const ok = await eliminar(token, { clave: CLAVE_ADMIN, eliminarNegocio: true });
    assert.equal(ok.estado, 200, ok.texto);
    const [empresa] = await consulta('SELECT estado_suscripcion, nombre_administradora FROM empresas WHERE id = $1', [empresaId]);
    assert.deepEqual(empresa, { estado_suscripcion: 'cancelada', nombre_administradora: 'Cuenta eliminada' });
    assert.equal((await consulta('SELECT count(*)::int AS n FROM usuarios WHERE empresa_id = $1', [empresaId]))[0].n, 0);
    assert.equal((await consulta('SELECT count(*)::int AS n FROM barberos WHERE empresa_id = $1 AND activo', [empresaId]))[0].n, 0);
    assert.equal((await consulta('SELECT count(*)::int AS n FROM lista_negra WHERE empresa_id = $1', [empresaId]))[0].n, 0, 'la lista negra del negocio se borra');
    const clientes = await consulta('SELECT nombre FROM clientes WHERE empresa_id = $1', [empresaId]);
    assert.deepEqual(clientes, [{ nombre: 'Cliente eliminado' }]);
    assert.equal((await consulta('SELECT count(*)::int AS n FROM citas WHERE empresa_id = $1', [empresaId]))[0].n, 1, 'las citas y la cartera se conservan');
    // Nadie del negocio entra y los clientes ya no pueden reservar
    assert.equal((await pedir(ctx, '/api/v1/servicios', { token })).estado, 401);
    const reserva = await pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      body: { empresaId, barberoId: pro.json.id, servicioId: servicio.json.id, fecha: fechaEnDias(3), hora: '10:00 AM', nombre: 'Otro', telefono: '3100000051', aceptaPoliticaDatos: true, aceptaTerminos: true },
    });
    assert.equal(reserva.estado, 403);
    assert.deepEqual(reserva.json, { error: 'Este negocio no está recibiendo reservas por ahora' });
  });

  test('si el negocio tiene otro administrador, borrar la cuenta solo borra esa cuenta y el negocio sigue', async () => {
    const r = await registrarEmpresa(ctx, { correo: 'compartida@central.co', numeroEmpleados: 2 });
    assert.equal(r.estado, 201);
    const otroAdmin = await pedir(ctx, '/api/v1/equipo', {
      method: 'POST',
      token: r.json.token,
      body: { nombre: 'Segundo Admin', usuario: 'segundo.admin', clave: 'Clave-segura-1', rol: 'admin', atiendeClientes: false },
    });
    assert.equal(otroAdmin.estado, 201, otroAdmin.texto);
    const ok = await eliminar(r.json.token, { clave: CLAVE_ADMIN });
    assert.equal(ok.estado, 200, ok.texto);
    const [empresa] = await consulta('SELECT estado_suscripcion FROM empresas WHERE id = $1', [r.json.empresa.id]);
    assert.equal(empresa.estado_suscripcion, 'trial', 'el negocio sigue como estaba');
    const segundo = await iniciarSesion(ctx, 'segundo.admin', 'Clave-segura-1');
    assert.equal((await pedir(ctx, '/api/v1/admin/empresa', { token: segundo })).estado, 200, 'el otro administrador sigue entrando');
  });
});
