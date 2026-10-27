import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fechaEnDias } from './apoyo/baseDePrueba.js';
import {
  CLAVE_CLIENTE,
  type Contexto,
  iniciar,
  iniciarSesion,
  pedir,
  registrarCliente,
  reservaValida,
  telefonoValido,
} from './apoyo/servidor.js';

const TOPE =
  'Ya tienes 3 citas pendientes en este negocio. Cancela una o espera a que se complete para reservar otra.';

const reservar = (ctx: Contexto, cambios: Record<string, unknown> = {}, token?: string) =>
  pedir(ctx, '/api/v1/citas', { method: 'POST', body: reservaValida(cambios), token });

// A-2 — reservas falsas: tope de citas pendientes por teléfono en cada negocio y tope por conexión
describe('tope de citas pendientes por teléfono', () => {
  let ctx: Contexto;
  let tokenAdminA: string;
  before(async () => {
    ctx = await iniciar();
    tokenAdminA = await iniciarSesion(ctx, 'admin.a', '1234');
  });
  after(() => ctx.cerrar());

  const horas = ['08:00 AM', '09:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '01:00 PM'];

  test('un invitado puede tener 3 citas pendientes en un negocio; la 4.ª responde 409 con el mensaje exacto', async () => {
    const telefono = telefonoValido(2001);
    const fecha = fechaEnDias(2);
    for (let i = 0; i < 3; i++) assert.equal((await reservar(ctx, { telefono, fecha, hora: horas[i] })).estado, 201);
    const cuarta = await reservar(ctx, { telefono, fecha, hora: horas[3] });
    assert.equal(cuarta.estado, 409);
    assert.deepEqual(cuarta.json, { error: TOPE });
    const { rows } = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM citas c JOIN clientes cl ON cl.id = c.cliente_id WHERE cl.telefono = $1',
      [`+57${telefono}`],
    );
    assert.equal(rows[0].n, 3, 'la cuarta no se guardó');
  });

  test('el mismo número escrito de otra forma cuenta como el mismo teléfono', async () => {
    const telefono = telefonoValido(2002);
    const fecha = fechaEnDias(3);
    const formas = [telefono, `+57 ${telefono}`, `57${telefono}`];
    for (const [i, t] of formas.entries()) assert.equal((await reservar(ctx, { telefono: t, fecha, hora: horas[i] })).estado, 201);
    const otra = await reservar(ctx, { telefono: `${telefono.slice(0, 3)} ${telefono.slice(3)}`, fecha, hora: horas[3] });
    assert.equal(otra.estado, 409);
  });

  test('otro teléfono no se ve afectado', async () => {
    const fecha = fechaEnDias(4);
    assert.equal((await reservar(ctx, { telefono: telefonoValido(2003), fecha, hora: horas[0] })).estado, 201);
    assert.equal((await reservar(ctx, { telefono: telefonoValido(2004), fecha, hora: horas[1] })).estado, 201);
  });

  test('el tope es por negocio: el mismo teléfono puede reservar en otro negocio', async () => {
    const telefono = telefonoValido(2005);
    const fecha = fechaEnDias(5);
    for (let i = 0; i < 3; i++) assert.equal((await reservar(ctx, { telefono, fecha, hora: horas[i] })).estado, 201);
    assert.equal((await reservar(ctx, { telefono, fecha, hora: horas[3] })).estado, 409);
    const enB = await reservar(ctx, { empresaId: 'emp_b', barberoId: 'admin_b', servicioId: 'serv_b', telefono, fecha, hora: horas[0] });
    assert.equal(enB.estado, 201, enB.texto);
  });

  test('cancelar una cita libera un lugar', async () => {
    const telefono = telefonoValido(2006);
    const fecha = fechaEnDias(6);
    const citas: string[] = [];
    for (let i = 0; i < 3; i++) citas.push((await reservar(ctx, { telefono, fecha, hora: horas[i] })).json.cita.id);
    assert.equal((await reservar(ctx, { telefono, fecha, hora: horas[3] })).estado, 409);
    const cancelar = await pedir(ctx, `/api/v1/citas/${citas[0]}/cancelar`, { method: 'PATCH', token: tokenAdminA });
    assert.equal(cancelar.estado, 200);
    assert.equal((await reservar(ctx, { telefono, fecha, hora: horas[3] })).estado, 201);
  });

  test('completar una cita también libera un lugar', async () => {
    const telefono = telefonoValido(2007);
    const fecha = fechaEnDias(7);
    const citas: string[] = [];
    for (let i = 0; i < 3; i++) citas.push((await reservar(ctx, { telefono, fecha, hora: horas[i] })).json.cita.id);
    // Solo el profesional de la cita (o la cuenta de la administradora) la marca como atendida
    const tokenBarberoA = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    const completar = await pedir(ctx, `/api/v1/citas/${citas[0]}/completar`, { method: 'PATCH', token: tokenBarberoA });
    assert.equal(completar.estado, 200, completar.texto);
    assert.equal((await reservar(ctx, { telefono, fecha, hora: horas[3] })).estado, 201);
  });

  test('una cita confirmada que ya pasó sin atenderse no cuenta como pendiente', async () => {
    const telefono = telefonoValido(2008);
    const fecha = fechaEnDias(8);
    const primera = await reservar(ctx, { telefono, fecha, hora: horas[0] });
    assert.equal(primera.estado, 201);
    // La cita queda atrás en el tiempo, sin marcarse como atendida
    await ctx.pool.query('UPDATE citas SET fecha = CURRENT_DATE - 5 WHERE id = $1', [primera.json.cita.id]);
    for (let i = 1; i <= 3; i++) assert.equal((await reservar(ctx, { telefono, fecha, hora: horas[i] })).estado, 201, `reserva ${i}`);
    assert.equal((await reservar(ctx, { telefono, fecha, hora: horas[4] })).estado, 409);
  });

  test('un cliente con cuenta tiene el mismo tope, y cuenta junto con sus reservas de invitado con ese número', async () => {
    const registro = await registrarCliente(ctx, 'tope@correo.com', CLAVE_CLIENTE, { telefono: telefonoValido(2009) });
    assert.equal(registro.estado, 201, registro.texto);
    const token = registro.json.token as string;
    const fecha = fechaEnDias(9);
    // Una reserva como invitado con su mismo número
    assert.equal((await reservar(ctx, { telefono: telefonoValido(2009), fecha, hora: horas[0] })).estado, 201);
    for (let i = 1; i < 3; i++) {
      const r = await reservar(ctx, { fecha, hora: horas[i] }, token);
      assert.equal(r.estado, 201, r.texto);
    }
    const cuarta = await reservar(ctx, { fecha, hora: horas[3] }, token);
    assert.equal(cuarta.estado, 409);
    assert.deepEqual(cuarta.json, { error: TOPE });
  });

  test('reservas simultáneas del mismo teléfono con distintos profesionales: solo 3 pasan', async () => {
    const telefono = telefonoValido(2010);
    const fecha = fechaEnDias(10);
    const intentos = [
      ...horas.slice(0, 3).map((hora) => reservar(ctx, { telefono, fecha, hora, barberoId: 'barb_a' })),
      ...horas.slice(0, 3).map((hora) => reservar(ctx, { telefono, fecha, hora, barberoId: 'barb_a2' })),
    ];
    const estados = (await Promise.all(intentos)).map((r) => r.estado).sort();
    assert.deepEqual(estados, [201, 201, 201, 409, 409, 409]);
  });

  test('el número máximo se puede cambiar con MAX_CITAS_PENDIENTES', async () => {
    const otro = await iniciar({ entorno: { MAX_CITAS_PENDIENTES: 2 } });
    try {
      const telefono = telefonoValido(2011);
      const fecha = fechaEnDias(3);
      for (let i = 0; i < 2; i++) assert.equal((await reservar(otro, { telefono, fecha, hora: horas[i] })).estado, 201);
      const tercera = await reservar(otro, { telefono, fecha, hora: horas[2] });
      assert.equal(tercera.estado, 409);
      assert.equal(tercera.json.error, TOPE.replace('3 citas', '2 citas'));
    } finally {
      await otro.cerrar();
    }
  });
});

describe('límite de reservas por conexión', () => {
  test('cuenta las reservas guardadas, no los intentos con error', async () => {
    const ctx = await iniciar({ limites: { reservasCreadas: 2 } });
    try {
      const fecha = fechaEnDias(3);
      // Intentos que fallan (validación, no existe, conflicto) no gastan el límite
      assert.equal((await reservar(ctx, { telefono: 'abc', fecha, hora: '08:00 AM' })).estado, 400);
      assert.equal((await reservar(ctx, { telefono: telefonoValido(2101), fecha, hora: '08:00 AM', barberoId: 'no_existe' })).estado, 404);
      assert.equal((await reservar(ctx, { telefono: telefonoValido(2102), fecha, hora: '08:00 AM' })).estado, 201);
      assert.equal((await reservar(ctx, { telefono: telefonoValido(2103), fecha, hora: '08:00 AM' })).estado, 409, 'hora ocupada: no cuenta');
      assert.equal((await reservar(ctx, { telefono: telefonoValido(2104), fecha, hora: '09:00 AM' })).estado, 201);
      const bloqueada = await reservar(ctx, { telefono: telefonoValido(2105), fecha, hora: '10:00 AM' });
      assert.equal(bloqueada.estado, 429);
      assert.deepEqual(bloqueada.json, { error: 'Hiciste muchas reservas desde esta conexión. Intenta de nuevo más tarde.' });
      const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM citas WHERE fecha = $1 AND empresa_id = 'emp_a'", [fecha]);
      assert.equal(rows[0].n, 2, 'la reserva bloqueada no se guardó');
    } finally {
      await ctx.cerrar();
    }
  });
});
