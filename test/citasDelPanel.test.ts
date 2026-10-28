import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fechaEnDias } from './apoyo/baseDePrueba.js';
import {
  CLAVE_CLIENTE,
  type Contexto,
  e164,
  esperarHasta,
  iniciar,
  iniciarSesion,
  pedir,
  registrarCliente,
  telefonoValido,
} from './apoyo/servidor.js';

// Citas creadas desde el panel: el empleado para sí mismo y el administrador para cualquier profesional
describe('crear citas desde el panel', () => {
  let ctx: Contexto;
  let tokenAdmin: string;
  let tokenAdminB: string;
  let tokenBarbero: string;
  before(async () => {
    ctx = await iniciar();
    tokenAdmin = await iniciarSesion(ctx, 'admin.a', '1234');
    tokenAdminB = await iniciarSesion(ctx, 'admin.b', 'clave-b');
    tokenBarbero = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
  });
  after(() => ctx.cerrar());

  const consulta = async (sql: string, parametros: unknown[] = []) => (await ctx.pool.query(sql, parametros)).rows;

  let n = 0;
  const crear = (token: string | undefined, cambios: Record<string, unknown> = {}) =>
    pedir(ctx, '/api/v1/citas/panel', {
      method: 'POST',
      token,
      body: {
        barberoId: 'barb_a',
        servicioId: 'serv_a',
        fecha: fechaEnDias(3),
        hora: '10:00 AM',
        nombre: 'Cliente del panel',
        telefono: telefonoValido(5000 + ++n),
        autorizacion_registrada_por_negocio: true,
        ...cambios,
      },
    });

  test('un administrador crea una cita con un cliente nuevo y queda la prueba de la autorización (registro_negocio)', async () => {
    const telefono = telefonoValido(4001);
    const r = await crear(tokenAdmin, { telefono, fecha: fechaEnDias(3), hora: '09:00 AM' });
    assert.equal(r.estado, 201, r.texto);
    assert.equal(r.json.mensaje, 'Cita agendada');
    assert.equal(r.json.cita.telefono, `+57${telefono}`);
    assert.equal(r.json.cita.estado, 'CONFIRMADA');

    const citas = await consulta(`SELECT estado, barbero_id, usuario_id FROM citas WHERE id = $1`, [r.json.cita.id]);
    assert.deepEqual(citas, [{ estado: 'CONFIRMADA', barbero_id: 'barb_a', usuario_id: null }]);
    const clientes = await consulta(`SELECT nombre, total_citas FROM clientes WHERE empresa_id = 'emp_a' AND telefono = $1`, [`+57${telefono}`]);
    assert.deepEqual(clientes, [{ nombre: 'Cliente del panel', total_citas: 1 }]);

    const pruebas = await consulta(
      `SELECT canal, telefono, indicativo, usuario_id, barbero_id, empresa_id, cita_id, version_politica IS NOT NULL AS con_version
       FROM auditoria_autorizaciones WHERE cita_id = $1`,
      [r.json.cita.id],
    );
    assert.deepEqual(pruebas, [
      { canal: 'registro_negocio', telefono: `+57${telefono}`, indicativo: '57', usuario_id: null, barbero_id: null, empresa_id: 'emp_a', cita_id: r.json.cita.id, con_version: true },
    ]);
  });

  test('sin "autorizacion_registrada_por_negocio" en verdadero responde 400 y no guarda nada', async () => {
    const mensaje = 'Confirma que el cliente autorizó el tratamiento de sus datos en "autorizacion_registrada_por_negocio"';
    const telefono = telefonoValido(4002);
    for (const cambios of [{ autorizacion_registrada_por_negocio: false }, { autorizacion_registrada_por_negocio: undefined }, { autorizacion_registrada_por_negocio: 'true' }]) {
      const r = await crear(tokenAdmin, { telefono, hora: '11:00 AM', ...cambios });
      assert.equal(r.estado, 400);
      assert.deepEqual(r.json, { error: mensaje });
    }
    assert.deepEqual(await consulta(`SELECT 1 FROM clientes WHERE telefono = $1`, [`+57${telefono}`]), []);
  });

  test('un empleado crea citas para sí mismo (con o sin barberoId) y no para otro profesional', async () => {
    const propia = await crear(tokenBarbero, { barberoId: undefined, hora: '12:00 PM' });
    assert.equal(propia.estado, 201, propia.texto);
    assert.equal(propia.json.cita.barberoId, 'barb_a');
    const conId = await crear(tokenBarbero, { barberoId: 'barb_a', hora: '12:30 PM' });
    assert.equal(conId.estado, 201, conId.texto);

    const ajena = await crear(tokenBarbero, { barberoId: 'barb_a2', hora: '12:00 PM' });
    assert.equal(ajena.estado, 403);
    assert.deepEqual(await consulta(`SELECT 1 FROM citas WHERE barbero_id = 'barb_a2' AND fecha = $1`, [fechaEnDias(3)]), []);
  });

  test('un administrador agenda para cualquier profesional de su negocio, no de otro', async () => {
    const r = await crear(tokenAdmin, { barberoId: 'barb_a2', hora: '03:00 PM' });
    assert.equal(r.estado, 201, r.texto);
    assert.equal(r.json.cita.barberoId, 'barb_a2');
    // El negocio B no puede usar a un profesional ni un servicio del negocio A
    assert.equal((await crear(tokenAdminB, { barberoId: 'barb_a', servicioId: 'serv_b' })).estado, 404);
    assert.equal((await crear(tokenAdminB, { barberoId: 'admin_b', servicioId: 'serv_a' })).estado, 404);
  });

  test('una hora ocupada responde 409 y dos peticiones a la vez no toman la misma hora', async () => {
    const fecha = fechaEnDias(4);
    const primera = await crear(tokenAdmin, { fecha, hora: '10:00 AM' });
    assert.equal(primera.estado, 201);
    const repetida = await crear(tokenAdmin, { fecha, hora: '10:00 AM' });
    assert.equal(repetida.estado, 409);

    const [a, b] = await Promise.all([
      crear(tokenAdmin, { fecha, hora: '02:00 PM' }),
      crear(tokenBarbero, { fecha, hora: '02:00 PM', barberoId: undefined }),
    ]);
    assert.deepEqual([a.estado, b.estado].sort(), [201, 409]);
    assert.deepEqual(await consulta(`SELECT count(*)::int AS n FROM citas WHERE barbero_id = 'barb_a' AND fecha = $1 AND hora_inicio = '14:00'`, [fecha]), [{ n: 1 }]);
  });

  test('una hora bloqueada, fuera del horario o que el cálculo de horas no ofrece se rechaza', async () => {
    const fecha = fechaEnDias(5);
    await consulta(
      `INSERT INTO bloqueos (barbero_id, fecha_especifica, hora_inicio, hora_fin, es_repetitivo)
       VALUES ('barb_a', $1, '16:00', '17:00', false)`,
      [fecha],
    );
    const bloqueada = await crear(tokenAdmin, { fecha, hora: '04:00 PM' });
    assert.equal(bloqueada.estado, 409, bloqueada.texto);
    const fuera = await crear(tokenAdmin, { fecha, hora: '11:00 PM' });
    assert.equal(fuera.estado, 400);
    assert.deepEqual(fuera.json, { error: 'La hora elegida está fuera del horario del negocio' });
    // Una hora que no es múltiplo del intervalo del negocio (30 min) no sale en las horas libres
    const desalineada = await crear(tokenAdmin, { fecha, hora: '10:15 AM' });
    assert.equal(desalineada.estado, 409);
  });

  test('las fechas pasadas o a más de 14 días se rechazan, igual que en las reservas', async () => {
    assert.equal((await crear(tokenAdmin, { fecha: fechaEnDias(-1) })).estado, 400);
    assert.equal((await crear(tokenAdmin, { fecha: fechaEnDias(15) })).estado, 400);
  });

  test('no aplica el tope de 3 citas pendientes por teléfono', async () => {
    const telefono = telefonoValido(4003);
    const fecha = fechaEnDias(6);
    for (const hora of ['08:00 AM', '08:30 AM', '09:00 AM', '09:30 AM', '10:00 AM']) {
      const r = await crear(tokenAdmin, { telefono, fecha, hora });
      assert.equal(r.estado, 201, r.texto);
    }
    assert.deepEqual(await consulta(`SELECT total_citas FROM clientes WHERE empresa_id = 'emp_a' AND telefono = $1`, [`+57${telefono}`]), [{ total_citas: 5 }]);
  });

  test('con un cliente existente usa sus datos; uno de otro negocio o datos repetidos se rechazan', async () => {
    const telefono = telefonoValido(4004);
    await crear(tokenAdmin, { telefono, nombre: 'Cliente Existente', fecha: fechaEnDias(3), hora: '04:00 PM' });
    const { clienteId } = (await consulta(`SELECT id AS "clienteId" FROM clientes WHERE empresa_id = 'emp_a' AND telefono = $1`, [`+57${telefono}`]))[0];

    const r = await crear(tokenAdmin, { nombre: undefined, telefono: undefined, clienteId, hora: '04:30 PM' });
    assert.equal(r.estado, 201, r.texto);
    assert.equal(r.json.cita.cliente, 'Cliente Existente');
    assert.deepEqual(await consulta(`SELECT total_citas FROM clientes WHERE id = $1`, [clienteId]), [{ total_citas: 2 }]);

    const deOtro = await crear(tokenAdmin, { nombre: undefined, telefono: undefined, clienteId: 'cli_b' });
    assert.equal(deOtro.estado, 404);
    assert.deepEqual(deOtro.json, { error: 'Cliente no encontrado' });

    const ambos = await crear(tokenAdmin, { clienteId });
    assert.equal(ambos.estado, 400);
    const ninguno = await crear(tokenAdmin, { nombre: undefined, telefono: undefined });
    assert.equal(ninguno.estado, 400);
  });

  test('si el cliente tiene cuenta, la cita queda en su cuenta y se le notifica sin tocar su aceptación de la política', async () => {
    const telefono = telefonoValido(4005);
    const cuenta = await registrarCliente(ctx, 'cliente.panel@correo.com', CLAVE_CLIENTE, { telefono });
    assert.equal(cuenta.estado, 201, cuenta.texto);
    const aceptacionesAntes = await consulta(`SELECT count(*)::int AS n FROM auditoria_autorizaciones WHERE usuario_id = $1`, [cuenta.json.usuario.id]);

    const r = await crear(tokenAdmin, { telefono, nombre: 'Otro nombre', fecha: fechaEnDias(3), hora: '05:00 PM' });
    assert.equal(r.estado, 201, r.texto);
    assert.deepEqual(await consulta(`SELECT usuario_id FROM citas WHERE id = $1`, [r.json.cita.id]), [{ usuario_id: cuenta.json.usuario.id }]);

    const aviso = await esperarHasta(async () => {
      const lista = await pedir(ctx, '/api/v1/notificaciones', { token: cuenta.json.token });
      return lista.json.datos.find((x: { tipo: string }) => x.tipo === 'cita_creada_por_negocio');
    });
    assert.equal(aviso.citaId, r.json.cita.id);
    assert.doesNotMatch(aviso.texto, /http|\$/, 'sin enlaces ni precios');
    const suyas = await pedir(ctx, '/api/v1/mi-cuenta/citas', { token: cuenta.json.token });
    assert.ok(suyas.json.some((c: { id: string }) => c.id === r.json.cita.id));

    const despues = await consulta(`SELECT count(*)::int AS n FROM auditoria_autorizaciones WHERE usuario_id = $1`, [cuenta.json.usuario.id]);
    assert.deepEqual(despues, aceptacionesAntes, 'la autorización del negocio no cuenta como aceptación de la cuenta');
  });

  test('un teléfono de la lista negra del negocio no puede agendarse', async () => {
    const telefono = telefonoValido(4006);
    await consulta(`INSERT INTO lista_negra (empresa_id, nombre, telefono) VALUES ('emp_a', 'Bloqueado', $1)`, [e164(4006)]);
    const r = await crear(tokenAdmin, { telefono, hora: '06:00 PM' });
    assert.equal(r.estado, 403);
  });

  test('sin sesión responde 401 y un cliente con cuenta 403', async () => {
    assert.equal((await crear(undefined)).estado, 401);
    const cliente = await registrarCliente(ctx, 'cliente.sin.acceso@correo.com', CLAVE_CLIENTE);
    assert.equal((await crear(cliente.json.token)).estado, 403);
  });
});
