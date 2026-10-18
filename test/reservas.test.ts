import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fechaEnDias } from './apoyo/baseDePrueba.js';
import { type Contexto, iniciar, iniciarSesion, pedir, reservaValida } from './apoyo/servidor.js';

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

  test('una reserva rechazada no suma citas al cliente', async () => {
    const fecha = fechaEnDias(12);
    assert.equal((await reservar(ctx, { fecha, telefono: '3444444444' })).estado, 201);
    assert.equal((await reservar(ctx, { fecha, telefono: '3555555555' })).estado, 409);
    const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM clientes WHERE telefono = '3555555555'");
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

  test('el mismo teléfono con otro indicativo es otro cliente (no un error 500)', async () => {
    const fecha = fechaEnDias(14);
    const colombia = await reservar(ctx, { fecha, hora: '09:00 AM', telefono: '5551234', indicativo: '57' });
    const mexico = await reservar(ctx, { fecha, hora: '10:00 AM', telefono: '5551234', indicativo: '52' });
    assert.equal(colombia.estado, 201);
    assert.equal(mexico.estado, 201);
    const { rows } = await ctx.pool.query("SELECT indicativo FROM clientes WHERE telefono = '5551234' ORDER BY 1");
    assert.deepEqual(rows.map((r) => r.indicativo), ['52', '57']);
  });

  test('un cliente que vuelve suma citas en lugar de duplicarse', async () => {
    const fecha = fechaEnDias(15);
    assert.equal((await reservar(ctx, { fecha, hora: '09:00 AM', telefono: '3666666666' })).estado, 201);
    assert.equal((await reservar(ctx, { fecha, hora: '10:00 AM', telefono: '3666666666' })).estado, 201);
    const { rows } = await ctx.pool.query("SELECT total_citas FROM clientes WHERE telefono = '3666666666'");
    assert.deepEqual(rows, [{ total_citas: 2 }]);
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

  // Contrato anterior: el teléfono se guardaba tal cual lo escribía el cliente
  // (el teclado phone-pad de Android permite # * , ; /) y indicativo null era "57"
  test('acepta teléfonos cortos o con símbolos del teclado y indicativo null', async () => {
    const corto = await reservar(ctx, { hora: '08:00 AM', telefono: '1234' });
    const conSimbolo = await reservar(ctx, { hora: '09:00 AM', telefono: '300#1234567' });
    const sinIndicativo = await reservar(ctx, { hora: '11:00 AM', telefono: '3007770000', indicativo: null });
    assert.equal(corto.estado, 201, corto.texto);
    assert.equal(conSimbolo.estado, 201, conSimbolo.texto);
    assert.equal(sinIndicativo.estado, 201, sinIndicativo.texto);
    assert.equal(sinIndicativo.json.cita.indicativo, '57');
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
