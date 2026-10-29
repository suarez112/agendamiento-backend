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
  registrarEmpresa,
  reservaValida,
  telefonoValido,
} from './apoyo/servidor.js';

// El negocio que registra la prueba atiende de lunes a sábado. Devuelve la primera fecha desde mañana que no es
// domingo (siempre a 1-2 días, dentro de la ventana de 14 días de las reservas), para no depender del día en que se corre.
const proximoDiaLaborable = () => {
  for (let dias = 1; dias <= 14; dias++) {
    const fecha = fechaEnDias(dias);
    if (new Date(`${fecha}T00:00:00Z`).getUTCDay() !== 0) return fecha;
  }
  throw new Error('No hay un día laborable dentro de la ventana de reservas');
};

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

  test('si el cliente tiene cuenta y ya guardó el negocio, la cita queda en su cuenta y se le notifica', async () => {
    const telefono = telefonoValido(4005);
    const cuenta = await registrarCliente(ctx, 'cliente.panel@correo.com', CLAVE_CLIENTE, { telefono });
    assert.equal(cuenta.estado, 201, cuenta.texto);
    const guardar = await pedir(ctx, '/api/v1/mi-cuenta/negocios', { method: 'POST', token: cuenta.json.token, body: { codigo: 'NEGA' } });
    assert.equal(guardar.estado, 201, guardar.texto);
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

  test('si el cliente tuvo citas en el negocio con su cuenta, también queda en su cuenta', async () => {
    const telefono = telefonoValido(4007);
    const cuenta = await registrarCliente(ctx, 'cliente.con.historial@correo.com', CLAVE_CLIENTE, { telefono });
    const previa = await pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      token: cuenta.json.token,
      body: reservaValida({ fecha: fechaEnDias(3), hora: '08:00 AM' }),
    });
    assert.equal(previa.estado, 201, previa.texto);

    const r = await crear(tokenAdmin, { telefono, fecha: fechaEnDias(3), hora: '08:30 AM' });
    assert.equal(r.estado, 201, r.texto);
    assert.deepEqual(await consulta(`SELECT usuario_id FROM citas WHERE id = $1`, [r.json.cita.id]), [{ usuario_id: cuenta.json.usuario.id }]);
  });

  test('si el cliente tiene cuenta pero ninguna relación con el negocio, la cita queda de invitado y no se notifica', async () => {
    const telefono = telefonoValido(4008);
    const cuenta = await registrarCliente(ctx, 'cliente.sin.relacion@correo.com', CLAVE_CLIENTE, { telefono });
    // Tiene relación con OTRO negocio, no con este
    const guardarOtro = await pedir(ctx, '/api/v1/mi-cuenta/negocios', { method: 'POST', token: cuenta.json.token, body: { codigo: 'NEGB' } });
    assert.equal(guardarOtro.estado, 201, guardarOtro.texto);

    const r = await crear(tokenAdmin, { telefono, fecha: fechaEnDias(3), hora: '03:00 PM' });
    assert.equal(r.estado, 201, r.texto);
    assert.deepEqual(await consulta(`SELECT usuario_id FROM citas WHERE id = $1`, [r.json.cita.id]), [{ usuario_id: null }]);
    // Se espera a que salgan los avisos del negocio y se comprueba que a la cuenta no le llegó ninguno
    await esperarHasta(async () => (await consulta(`SELECT 1 FROM notificaciones WHERE cita_id = $1`, [r.json.cita.id])).length > 0);
    assert.deepEqual(await consulta(`SELECT 1 FROM notificaciones WHERE usuario_id = $1`, [cuenta.json.usuario.id]), []);
    const suyas = await pedir(ctx, '/api/v1/mi-cuenta/citas', { token: cuenta.json.token });
    assert.ok(!suyas.json.some((c: { id: string }) => c.id === r.json.cita.id));
  });

  test('la prueba registro_negocio guarda qué miembro del equipo la declaró, sin contarla como su aceptación', async () => {
    const porAdmin = await crear(tokenAdmin, { fecha: fechaEnDias(5), hora: '08:00 AM' });
    const porEmpleado = await crear(tokenBarbero, { barberoId: undefined, fecha: fechaEnDias(5), hora: '08:30 AM' });
    assert.equal(porAdmin.estado, 201, porAdmin.texto);
    assert.equal(porEmpleado.estado, 201, porEmpleado.texto);
    const filas = await consulta(
      `SELECT cita_id, registrada_por_barbero_id AS barbero, registrada_por_usuario_id AS usuario, barbero_id, usuario_id
       FROM auditoria_autorizaciones WHERE cita_id = ANY($1) ORDER BY registrada_por_barbero_id`,
      [[porAdmin.json.cita.id, porEmpleado.json.cita.id]],
    );
    assert.deepEqual(filas, [
      { cita_id: porAdmin.json.cita.id, barbero: 'admin_a', usuario: null, barbero_id: null, usuario_id: null },
      { cita_id: porEmpleado.json.cita.id, barbero: 'barb_a', usuario: null, barbero_id: null, usuario_id: null },
    ]);
    // Quien la declaró no queda como si hubiera aceptado la política
    const estado = await pedir(ctx, '/api/v1/legal/estado', { token: tokenAdmin });
    assert.equal(estado.json.ultimaAceptacion, null);
    assert.equal(estado.json.vigente, false);
  });

  test('una cuenta admin (la de correo) que agenda queda registrada en registrada_por_usuario_id, no en la columna del equipo', async () => {
    const registro = await registrarEmpresa(ctx, { correo: 'admin.panel.cuenta@central.co' });
    assert.equal(registro.estado, 201, registro.texto);
    const token = registro.json.token as string;
    const servicio = await pedir(ctx, '/api/v1/servicios', { method: 'POST', token, body: { nombre: 'Corte', duracionMin: 30, precio: 20000 } });
    assert.equal(servicio.estado, 201, servicio.texto);
    const profesional = await pedir(ctx, '/api/v1/equipo', {
      method: 'POST',
      token,
      body: { nombre: 'Carlos', usuario: 'carlos.panel', clave: 'Clave-segura-1', rol: 'empleado' },
    });
    assert.equal(profesional.estado, 201, profesional.texto);

    const dia = proximoDiaLaborable();
    const r = await pedir(ctx, '/api/v1/citas/panel', {
      method: 'POST',
      token,
      body: {
        barberoId: profesional.json.id,
        servicioId: servicio.json.id,
        fecha: dia,
        hora: '10:00 AM',
        nombre: 'Cliente de la cuenta admin',
        telefono: telefonoValido(4010),
        autorizacion_registrada_por_negocio: true,
      },
    });
    assert.equal(r.estado, 201, r.texto);

    const filas = await consulta(
      `SELECT canal, registrada_por_barbero_id AS barbero, registrada_por_usuario_id AS usuario, barbero_id, usuario_id
       FROM auditoria_autorizaciones WHERE cita_id = $1`,
      [r.json.cita.id],
    );
    assert.deepEqual(filas, [
      { canal: 'registro_negocio', barbero: null, usuario: registro.json.usuario.id, barbero_id: null, usuario_id: null },
    ]);
  });

  test('la base exige quién declaró la autorización en el canal registro_negocio, y solo en ese canal', async () => {
    const insertar = (canal: string, barbero: string | null) =>
      ctx.pool.query(
        `INSERT INTO auditoria_autorizaciones (canal, version_politica, version_terminos, telefono, registrada_por_barbero_id)
         VALUES ($1, '1.0', '1.0', '+573001110000', $2)`,
        [canal, barbero],
      );
    await assert.rejects(insertar('registro_negocio', null), /auditoria_autorizaciones_quien_registro/);
    await assert.rejects(insertar('reserva_invitado', 'barb_a'), /auditoria_autorizaciones_quien_registro/);
    await insertar('registro_negocio', 'barb_a');
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

  describe('horas libres del panel', () => {
    const fecha = fechaEnDias(8);
    const horasDe = (r: { json: { horas: { inicio: string; pegada: boolean }[] } }) =>
      new Map(r.json.horas.map((h) => [h.inicio, h.pegada]));
    const panel = (token: string | undefined, extra: Record<string, string>) =>
      pedir(ctx, `/api/v1/citas/panel/disponibilidad?${new URLSearchParams({ servicioId: 'serv_a', fecha, ...extra })}`, { token });

    before(async () => {
      // Bloqueo de 08:00 a 08:50: la hora de las 09:00 dejaría un hueco de 10 min (menor que el servicio más corto, 30)
      await consulta(
        `INSERT INTO bloqueos (barbero_id, fecha_especifica, hora_inicio, hora_fin, es_repetitivo) VALUES ('barb_a2', $1, '08:00', '08:50', false)`,
        [fecha],
      );
      // Una cita de 12:00 a 12:30
      const cita = await crear(tokenAdmin, { barberoId: 'barb_a2', fecha, hora: '12:00 PM' });
      assert.equal(cita.estado, 201, cita.texto);
    });

    test('el cliente no ve las horas que dejan un hueco corto; el panel sí, y las pegadas siguen marcadas', async () => {
      const publico = await pedir(
        ctx,
        `/api/v1/citas/disponibilidad?${new URLSearchParams({ empresaId: 'emp_a', barberoId: 'barb_a2', servicioId: 'serv_a', fecha })}`,
      );
      const delCliente = horasDe(publico);
      assert.equal(delCliente.has('09:00'), false, 'el cliente no ve 09:00 (deja 10 min libres antes)');
      assert.equal(delCliente.get('08:50'), true);

      const r = await panel(tokenAdmin, { barberoId: 'barb_a2' });
      assert.equal(r.estado, 200, r.texto);
      const delPanel = horasDe(r);
      assert.equal(delPanel.get('09:00'), false, 'el panel sí ofrece 09:00 (no es pegada)');
      assert.equal(delPanel.get('08:50'), true, 'la pegada al bloqueo sigue recomendada');
      assert.equal(r.json.intervaloMinutos, 30);
      // Todo lo que ve el cliente también lo ve el panel
      for (const [inicio, pegada] of delCliente) assert.equal(delPanel.get(inicio), pegada, inicio);
    });

    test('solo ofrece horas del intervalo (o pegadas), dentro del horario y sin choques con citas ni bloqueos', async () => {
      const r = horasDe(await panel(tokenAdmin, { barberoId: 'barb_a2' }));
      for (const bloqueada of ['08:00', '08:30']) assert.ok(!r.has(bloqueada), `${bloqueada} está bloqueada`);
      assert.ok(!r.has('12:00'), 'tiene una cita a las 12:00');
      assert.ok(!r.has('11:45'), 'un servicio de 30 min chocaría con la cita de las 12:00');
      for (const [h, pegada] of r) {
        const [hh, mm] = h.split(':').map(Number);
        const minutos = hh * 60 + mm;
        assert.ok(minutos >= 8 * 60 && minutos + 30 <= 20 * 60, `${h} fuera del horario`);
        // Fuera del intervalo de 30 minutos solo pueden aparecer las pegadas
        if (mm % 30 !== 0) assert.equal(pegada, true, h);
      }
    });

    test('se puede agendar una hora que el panel ofrece y el cliente no, y una que no ofrece se rechaza', async () => {
      const ofrecida = await crear(tokenAdmin, { barberoId: 'barb_a2', fecha, hora: '09:00 AM' });
      assert.equal(ofrecida.estado, 201, ofrecida.texto);
      const noOfrecida = await crear(tokenAdmin, { barberoId: 'barb_a2', fecha, hora: '12:00 PM' });
      assert.equal(noOfrecida.estado, 409);
    });

    test('un empleado ve solo las horas propias; sin sesión, con cliente u otro negocio se rechaza', async () => {
      assert.equal((await panel(tokenBarbero, {})).estado, 200);
      assert.equal((await panel(tokenBarbero, { barberoId: 'barb_a2' })).estado, 403);
      assert.equal((await panel(undefined, {})).estado, 401);
      const cliente = await registrarCliente(ctx, 'cliente.horas@correo.com', CLAVE_CLIENTE);
      assert.equal((await panel(cliente.json.token, {})).estado, 403);
      assert.equal((await panel(tokenAdminB, { barberoId: 'barb_a2' })).estado, 404);
    });
  });
});
