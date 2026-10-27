import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fechaEnDias } from './apoyo/baseDePrueba.js';
import { type Contexto, e164, iniciar, iniciarSesion, pedir, reservaValida, telefonoValido } from './apoyo/servidor.js';

const reservar = (ctx: Contexto, cambios: Record<string, unknown> = {}) =>
  pedir(ctx, '/api/v1/citas', { method: 'POST', body: reservaValida(cambios) });

// S9, S12 — doble reserva y restricciones de integridad
describe('reservas simultáneas', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  test('20 solicitudes simultáneas por el mismo horario: solo una se agenda', async () => {
    const fecha = fechaEnDias(10);
    const respuestas = await Promise.all(
      Array.from({ length: 20 }, (_, i) => reservar(ctx, { fecha, hora: '11:00 AM', telefono: `30000000${String(i).padStart(2, '0')}` })),
    );
    const estados = respuestas.map((r) => r.estado).sort();
    assert.deepEqual(estados, [201, ...Array(19).fill(409)]);
    const { rows } = await ctx.pool.query(
      "SELECT count(*)::int AS n FROM citas WHERE barbero_id = 'barb_a' AND fecha = $1 AND estado <> 'CANCELADA'",
      [fecha],
    );
    assert.equal(rows[0].n, 1);
  });

  test('solicitudes simultáneas que se solapan parcialmente: solo una se agenda', async () => {
    const fecha = fechaEnDias(11);
    const respuestas = await Promise.all([
      reservar(ctx, { fecha, hora: '02:00 PM', servicioId: 'serv_a_largo', telefono: '3111111111' }),
      reservar(ctx, { fecha, hora: '02:30 PM', telefono: '3222222222' }),
      reservar(ctx, { fecha, hora: '02:45 PM', telefono: '3333333333' }),
    ]);
    assert.equal(respuestas.filter((r) => r.estado === 201).length, 1);
    assert.ok(respuestas.every((r) => r.estado === 201 || r.estado === 409));
  });

  test('dos reservas simultáneas a la misma hora: una se agenda y la otra recibe 409', async () => {
    const fecha = fechaEnDias(6);
    // Varias rondas, cada una en una hora distinta, para no depender de un golpe de suerte con el orden
    for (const [ronda, hora] of ['08:00 AM', '09:00 AM', '10:00 AM', '11:00 AM', '12:00 PM'].entries()) {
      const [a, b] = await Promise.all([
        reservar(ctx, { fecha, hora, telefono: telefonoValido(10 + ronda * 2) }),
        reservar(ctx, { fecha, hora, telefono: telefonoValido(11 + ronda * 2) }),
      ]);
      assert.deepEqual([a.estado, b.estado].sort(), [201, 409], `ronda ${ronda}: ${a.texto} ${b.texto}`);
      const rechazada = a.estado === 409 ? a : b;
      assert.deepEqual(rechazada.json, { error: 'Esa hora ya está ocupada. Por favor elige otra.' });
      const { rows } = await ctx.pool.query(
        "SELECT count(*)::int AS n FROM citas WHERE barbero_id = 'barb_a' AND fecha = $1 AND estado <> 'CANCELADA' AND hora_inicio = $2::time",
        [fecha, `${String(8 + ronda).padStart(2, '0')}:00`],
      );
      assert.equal(rows[0].n, 1, `ronda ${ronda}: una sola cita en esa hora`);
    }
  });

  test('una reserva y un bloqueo simultáneos sobre la misma hora: solo uno se guarda', async () => {
    const fecha = fechaEnDias(6);
    const token = await iniciarSesion(ctx, 'admin.a', '1234');
    for (const [ronda, hora] of ['01:00 PM', '02:00 PM', '03:00 PM', '04:00 PM'].entries()) {
      const inicio = `${13 + ronda}:00`;
      const fin = `${14 + ronda}:00`;
      const [cita, bloqueo] = await Promise.all([
        reservar(ctx, { fecha, hora, telefono: telefonoValido(40 + ronda) }),
        pedir(ctx, '/api/v1/bloqueos', { method: 'POST', token, body: { barberoId: 'barb_a', fecha, horaInicio: inicio, horaFin: fin } }),
      ]);
      const guardadas = [cita.estado === 201, bloqueo.estado === 201].filter(Boolean).length;
      assert.equal(guardadas, 1, `ronda ${ronda}: cita ${cita.estado} ${cita.texto} / bloqueo ${bloqueo.estado} ${bloqueo.texto}`);
      assert.ok([cita.estado, bloqueo.estado].every((e) => e === 201 || e === 409));
      // Nunca quedan las dos cosas encima una de la otra
      const { rows } = await ctx.pool.query(
        `SELECT (SELECT count(*)::int FROM citas WHERE barbero_id = 'barb_a' AND fecha = $1 AND estado <> 'CANCELADA' AND hora_inicio = $2::time) AS citas,
                (SELECT count(*)::int FROM bloqueos WHERE barbero_id = 'barb_a' AND fecha_especifica = $1 AND hora_inicio = $2::time) AS bloqueos`,
        [fecha, inicio],
      );
      assert.equal(rows[0].citas + rows[0].bloqueos, 1, `ronda ${ronda}`);
    }
  });

  test('una reserva rechazada no suma citas al cliente', async () => {
    const fecha = fechaEnDias(12);
    assert.equal((await reservar(ctx, { fecha, telefono: telefonoValido(1) })).estado, 201);
    assert.equal((await reservar(ctx, { fecha, telefono: telefonoValido(2) })).estado, 409);
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM clientes WHERE telefono = $1', [e164(2)]);
    assert.equal(rows[0].n, 0);
  });

  test('cancelar una cita libera el horario', async () => {
    const fecha = fechaEnDias(13);
    const primera = await reservar(ctx, { fecha, hora: '04:00 PM' });
    assert.equal(primera.estado, 201);
    const token = await iniciarSesion(ctx, 'admin.a', '1234');
    const cancelada = await pedir(ctx, `/api/v1/citas/${primera.json.cita.id}/cancelar`, { method: 'PATCH', token });
    assert.equal(cancelada.estado, 200);
    assert.equal((await reservar(ctx, { fecha, hora: '04:00 PM' })).estado, 201);
  });

  test('números de países distintos son clientes distintos (no un error 500)', async () => {
    const fecha = fechaEnDias(14);
    const colombia = await reservar(ctx, { fecha, hora: '09:00 AM', telefono: '3001234567', indicativo: '57' });
    const mexico = await reservar(ctx, { fecha, hora: '10:00 AM', telefono: '5512345678', indicativo: '52' });
    assert.equal(colombia.estado, 201);
    assert.equal(mexico.estado, 201);
    const { rows } = await ctx.pool.query(
      "SELECT telefono, indicativo FROM clientes WHERE telefono IN ('+573001234567', '+525512345678') ORDER BY 1",
    );
    assert.deepEqual(rows, [
      { telefono: '+525512345678', indicativo: '52' },
      { telefono: '+573001234567', indicativo: '57' },
    ]);
  });

  test('un cliente que vuelve suma citas en lugar de duplicarse', async () => {
    const fecha = fechaEnDias(9);
    assert.equal((await reservar(ctx, { fecha, hora: '09:00 AM', telefono: telefonoValido(3) })).estado, 201);
    assert.equal((await reservar(ctx, { fecha, hora: '10:00 AM', telefono: telefonoValido(3) })).estado, 201);
    const { rows } = await ctx.pool.query('SELECT total_citas FROM clientes WHERE telefono = $1', [e164(3)]);
    assert.deepEqual(rows, [{ total_citas: 2 }]);
  });

  test('el mismo número escrito de otra forma es el mismo cliente', async () => {
    const fecha = fechaEnDias(8);
    // Tres formas de escribir el mismo número (el tope de citas pendientes por teléfono es 3)
    const formas = ['3100000004', '310 000 0004', '+57 310-000-0004'];
    for (const [i, telefono] of formas.entries()) {
      const r = await reservar(ctx, { fecha, hora: `0${i + 1}:00 PM`, telefono });
      assert.equal(r.estado, 201, `${telefono}: ${r.texto}`);
      assert.equal(r.json.cita.telefono, e164(4), 'la respuesta trae el teléfono en E.164');
    }
    const { rows } = await ctx.pool.query('SELECT total_citas FROM clientes WHERE telefono = $1', [e164(4)]);
    assert.deepEqual(rows, [{ total_citas: 3 }]);
    // Una cuarta forma del mismo número es la misma persona: topa en las 3 citas pendientes
    const cuarta = await reservar(ctx, { fecha, hora: '04:00 PM', telefono: '573100000004' });
    assert.equal(cuarta.estado, 409);
  });

  test('la base rechaza estados y horarios inválidos', async () => {
    const insertar = (estado: string, inicio: string, fin: string) =>
      ctx.pool.query(
        `INSERT INTO citas (id, empresa_id, barbero_id, servicio_id, cliente_id, fecha, hora_inicio, hora_fin, precio, estado)
         VALUES (gen_random_uuid()::text, 'emp_b', 'admin_b', 'serv_b', 'cli_b', CURRENT_DATE + 40, $2, $3, 1, $1)`,
        [estado, inicio, fin],
      );
    await assert.rejects(insertar('INVENTADO', '09:00', '09:30'), { code: '23514' });
    await assert.rejects(insertar('CONFIRMADA', '10:00', '09:00'), { code: '23514' });
  });
});

// S4 — validación de entradas e inyección SQL
describe('validación de entradas de una reserva', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  const casos: [string, Record<string, unknown>, string][] = [
    ['fecha inexistente', { fecha: '2026-02-31' }, 'La fecha o la hora tienen un formato incorrecto'],
    ['hora imposible', { hora: '99:00 AM' }, 'La fecha o la hora tienen un formato incorrecto'],
    ['hora 13 PM', { hora: '13:00 PM' }, 'La fecha o la hora tienen un formato incorrecto'],
    ['nombre que no es texto', { nombre: 12345 }, 'Faltan datos para agendar la cita'],
    ['nombre vacío', { nombre: '   ' }, 'Faltan datos para agendar la cita'],
    ['nombre demasiado largo', { nombre: 'x'.repeat(500) }, 'El nombre es demasiado largo'],
    ['teléfono demasiado largo', { telefono: '3'.repeat(31) }, 'El teléfono no es válido'],
    ['año fuera del rango de PostgreSQL', { fecha: '0000-01-01' }, 'La fecha o la hora tienen un formato incorrecto'],
    ['indicativo inválido', { indicativo: '12345' }, 'El indicativo del país no es válido'],
    ['identificador como objeto', { empresaId: { $gt: '' } }, 'Faltan datos para agendar la cita'],
    ['fecha pasada', { fecha: fechaEnDias(-5) }, 'No se pueden agendar citas en fechas pasadas'],
    ['antes de abrir', { hora: '07:30 AM' }, 'La hora elegida está fuera del horario del negocio'],
    ['termina después del cierre', { hora: '07:45 PM' }, 'La hora elegida está fuera del horario del negocio'],
  ];

  for (const [nombre, cambios, mensaje] of casos) {
    test(`rechaza ${nombre} con 400`, async () => {
      const r = await reservar(ctx, cambios);
      assert.equal(r.estado, 400, r.texto);
      assert.equal(r.json?.error, mensaje);
    });
  }

  // Contrato vigente: el teléfono se valida y se guarda en E.164. Antes se guardaba tal cual lo escribía el
  // cliente; ahora se aceptan los formatos habituales, indicativo null es Colombia (57) y lo que no es un
  // número real se rechaza con 400 (sin crear cliente ni cita).
  test('acepta los formatos habituales de un teléfono y rechaza los que no son números reales', async () => {
    const conEspacios = await reservar(ctx, { hora: '08:00 AM', telefono: '300 777 0000', indicativo: '57' });
    const sinIndicativo = await reservar(ctx, { hora: '11:00 AM', telefono: '3007770001', indicativo: null });
    const conMas = await reservar(ctx, { hora: '12:00 PM', telefono: '+57 300 777 0002', indicativo: '52' });
    // El teclado numérico de Android permite # * , ; /: se limpian al normalizar
    const conSimbolos = await reservar(ctx, { hora: '01:00 PM', telefono: '300#777*0003' });
    assert.equal(conEspacios.estado, 201, conEspacios.texto);
    assert.equal(sinIndicativo.estado, 201, sinIndicativo.texto);
    assert.equal(sinIndicativo.json.cita.indicativo, '57');
    assert.equal(sinIndicativo.json.cita.telefono, '+573007770001');
    assert.equal(conMas.estado, 201, conMas.texto);
    assert.equal(conMas.json.cita.indicativo, '57', 'manda el código de país del propio número');
    assert.equal(conSimbolos.estado, 201, conSimbolos.texto);
    assert.equal(conSimbolos.json.cita.telefono, '+573007770003');

    const citas = (await ctx.pool.query('SELECT count(*)::int AS n FROM citas')).rows[0].n;
    for (const telefono of ['1234', '3444444444', 'abcdefghij', '0'.repeat(16), '300 123']) {
      const r = await reservar(ctx, { hora: '03:00 PM', telefono });
      assert.equal(r.estado, 400, telefono);
      assert.match(r.json.error, /^El número de teléfono no es válido/, telefono);
    }
    assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM citas')).rows[0].n, citas);
  });

  test('una reserva que termina justo al cierre es válida', async () => {
    assert.equal((await reservar(ctx, { hora: '07:30 PM' })).estado, 201);
  });

  test('inyección SQL en los parámetros no altera la consulta', async () => {
    const ocupadas = await pedir(ctx, `/api/v1/citas/ocupadas?empresaId=${encodeURIComponent("emp_a' OR '1'='1")}`);
    assert.equal(ocupadas.estado, 200);
    assert.deepEqual(ocupadas.json, []);

    const codigo = await pedir(ctx, `/api/v1/empresas/validar/${encodeURIComponent("X' OR '1'='1")}`);
    assert.equal(codigo.estado, 404);

    const reserva = await reservar(ctx, { empresaId: "emp_a'; DROP TABLE citas; --" });
    assert.equal(reserva.estado, 404);
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM citas');
    assert.ok(rows[0].n >= 1, 'la tabla citas sigue existiendo');
  });

  test('empresaId repetido en la URL responde 400', async () => {
    const r = await pedir(ctx, '/api/v1/citas/ocupadas?empresaId=emp_a&empresaId=emp_b');
    assert.equal(r.estado, 400);
  });
});
