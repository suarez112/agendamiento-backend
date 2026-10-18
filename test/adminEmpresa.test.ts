import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  type Contexto,
  iniciar,
  iniciarSesion,
  pedir,
  registrarCliente,
  registrarEmpresa,
  reservaValida,
} from './apoyo/servidor.js';
import { fechaEnDias } from './apoyo/baseDePrueba.js';

const MENSAJE_PRUEBA_VENCIDA =
  'Tu prueba gratuita de 15 días terminó. Activa tu suscripción para seguir usando las funciones de administrador.';
const SOLO_ADMIN = 'Solo el administrador de una empresa puede usar esta función.';

// S4, S5, S6, S7 — prueba gratuita, días restantes y permisos por rol
describe('administración de la empresa', () => {
  let ctx: Contexto;
  let tokenA: string;
  let empresaA: string;
  let tokenB: string;
  let empresaB: string;
  let tokenCliente: string;

  before(async () => {
    ctx = await iniciar();
    const a = await registrarEmpresa(ctx, { correo: 'admin@a.co', nit: '111' });
    const b = await registrarEmpresa(ctx, { correo: 'admin@b.co', nit: '222', nombre: 'Empresa B' });
    const cliente = await registrarCliente(ctx, 'cliente@correo.com', 'mi-clave-123');
    assert.deepEqual([a.estado, b.estado, cliente.estado], [201, 201, 201]);
    [tokenA, empresaA] = [a.json.token, a.json.empresa.id];
    [tokenB, empresaB] = [b.json.token, b.json.empresa.id];
    tokenCliente = cliente.json.token;
  });
  after(() => ctx.cerrar());

  // Cada prueba empieza con ambas empresas en una prueba de 15 días recién iniciada
  beforeEach(async () => {
    await ctx.pool.query(
      `UPDATE empresas SET estado_suscripcion = 'trial', trial_ends_at = now() + interval '15 days'
       WHERE id = ANY($1)`,
      [[empresaA, empresaB]],
    );
  });

  const finDePrueba = (empresaId: string, intervalo: string) =>
    ctx.pool.query(`UPDATE empresas SET trial_ends_at = now() + $2::interval WHERE id = $1`, [empresaId, intervalo]);

  const prueba = (token: string) => pedir(ctx, '/api/v1/admin/empresa/prueba', { token });
  const verEmpresa = (token: string) => pedir(ctx, '/api/v1/admin/empresa', { token });
  const editarEmpresa = (token: string, body: unknown) =>
    pedir(ctx, '/api/v1/admin/empresa', { method: 'PATCH', token, body });

  test('una empresa recién registrada tiene 15 días de prueba', async () => {
    const r = await prueba(tokenA);
    assert.equal(r.estado, 200);
    assert.equal(r.json.estadoSuscripcion, 'trial');
    assert.equal(r.json.diasRestantes, 15);
    assert.equal(r.json.pruebaVencida, false);
    assert.equal(typeof r.json.trialEndsAt, 'string');
  });

  test('cuenta los días que quedan, redondeando hacia arriba', async () => {
    await finDePrueba(empresaA, '12 days - 1 hour');
    assert.equal((await prueba(tokenA)).json.diasRestantes, 12);
    await finDePrueba(empresaA, '2 hours');
    assert.equal((await prueba(tokenA)).json.diasRestantes, 1);
  });

  test('cuando la prueba vence bloquea los endpoints de administrador con un mensaje claro', async () => {
    await finDePrueba(empresaA, '-1 minute');

    const ver = await verEmpresa(tokenA);
    assert.equal(ver.estado, 402);
    assert.deepEqual(ver.json, { error: MENSAJE_PRUEBA_VENCIDA });

    const editar = await editarEmpresa(tokenA, { ciudad: 'Cali' });
    assert.equal(editar.estado, 402);
    assert.deepEqual(editar.json, { error: MENSAJE_PRUEBA_VENCIDA });
    const { rows } = await ctx.pool.query('SELECT ciudad FROM empresas WHERE id = $1', [empresaA]);
    assert.equal(rows[0].ciudad, 'Bucaramanga', 'no se modificó nada');

    // La otra empresa sigue en prueba y no se ve afectada
    assert.equal((await verEmpresa(tokenB)).estado, 200);
  });

  test('con la prueba vencida todavía puede consultar sus días (0)', async () => {
    await finDePrueba(empresaA, '-3 days');
    const r = await prueba(tokenA);
    assert.equal(r.estado, 200);
    assert.equal(r.json.diasRestantes, 0);
    assert.equal(r.json.pruebaVencida, true);
  });

  test('una suscripción activa no tiene límite de prueba', async () => {
    await ctx.pool.query(
      "UPDATE empresas SET estado_suscripcion = 'activa', trial_ends_at = now() - interval '1 day' WHERE id = $1",
      [empresaA],
    );
    assert.equal((await verEmpresa(tokenA)).estado, 200);
    const r = await prueba(tokenA);
    assert.deepEqual(
      { estado: r.json.estadoSuscripcion, dias: r.json.diasRestantes, vencida: r.json.pruebaVencida },
      { estado: 'activa', dias: null, vencida: false },
    );
  });

  test('el admin ve solo los datos de su propia empresa', async () => {
    const a = await verEmpresa(tokenA);
    assert.equal(a.estado, 200);
    assert.equal(a.json.id, empresaA);
    assert.equal(a.json.correo, 'admin@a.co');
    assert.equal(a.json.nit, '111');
    assert.deepEqual(a.json.diasAtencion, [1, 2, 3, 4, 5, 6]);
    assert.equal(a.json.horarioApertura, '08:00');
    assert.equal(a.json.horarioCierre, '19:00');
    assert.equal(a.json.estadoSuscripcion, 'trial');
    assert.equal(a.json.password_hash, undefined);

    const b = await verEmpresa(tokenB);
    assert.equal(b.json.id, empresaB);
    assert.equal(b.json.nombre, 'Empresa B');
  });

  test('el admin modifica solo su empresa, aunque envíe el id de otra', async () => {
    const r = await editarEmpresa(tokenA, {
      id: empresaB,
      empresaId: empresaB,
      ciudad: 'Medellín',
      numeroEmpleados: 7,
      horarioCierre: '20:30',
      estadoSuscripcion: 'activa',
      trialEndsAt: '2099-01-01',
    });
    assert.equal(r.estado, 200);
    assert.equal(r.json.id, empresaA);
    assert.equal(r.json.ciudad, 'Medellín');
    assert.equal(r.json.numeroEmpleados, 7);
    assert.equal(r.json.horarioCierre, '20:30');
    assert.equal(r.json.estadoSuscripcion, 'trial', 'no puede activarse la suscripción a sí mismo');

    const { rows } = await ctx.pool.query(
      'SELECT id, ciudad, numero_empleados, estado_suscripcion FROM empresas WHERE id = ANY($1) ORDER BY id = $2 DESC',
      [[empresaA, empresaB], empresaA],
    );
    assert.deepEqual(rows[0], { id: empresaA, ciudad: 'Medellín', numero_empleados: 7, estado_suscripcion: 'trial' });
    assert.deepEqual(rows[1], { id: empresaB, ciudad: 'Bucaramanga', numero_empleados: 4, estado_suscripcion: 'trial' });
  });

  test('la edición aplica las mismas validaciones del registro', async () => {
    const casos: [unknown, number, string][] = [
      [{}, 400, 'Envía al menos un dato para actualizar'],
      [{ horarioApertura: '21:00', horarioCierre: '20:00' }, 400, 'La hora de cierre debe ser posterior a la hora de apertura'],
      // Solo cambia la apertura, pero queda después del cierre guardado
      [{ horarioApertura: '23:00' }, 400, 'La hora de cierre debe ser posterior a la hora de apertura'],
      [{ numeroEmpleados: 0 }, 400, 'El número de empleados debe ser un número entero mayor que cero'],
      [{ correo: 'no-es-correo' }, 400, 'El correo no es válido'],
      [{ nombre: '' }, 400, 'El campo "nombre" es obligatorio'],
      [{ nit: '222' }, 409, 'Ya existe una empresa registrada con ese NIT'],
    ];
    for (const [cuerpo, estado, error] of casos) {
      const r = await editarEmpresa(tokenA, cuerpo);
      assert.equal(r.estado, estado, JSON.stringify(cuerpo));
      assert.deepEqual(r.json, { error });
    }
    // Quitar el NIT (es opcional) sí se permite
    const sinNit = await editarEmpresa(tokenA, { nit: null });
    assert.equal(sinNit.estado, 200);
    assert.equal(sinNit.json.nit, null);
  });

  test('un cliente no puede usar los endpoints de administrador', async () => {
    for (const r of [
      await verEmpresa(tokenCliente),
      await editarEmpresa(tokenCliente, { ciudad: 'Cali' }),
      await prueba(tokenCliente),
    ]) {
      assert.equal(r.estado, 403);
      assert.deepEqual(r.json, { error: SOLO_ADMIN });
    }
  });

  test('sin sesión, o con un token del personal, responde 401', async () => {
    const tokenBarbero = await iniciarSesion(ctx, 'admin.a', '1234');
    for (const token of [undefined, 'token-falso', tokenBarbero]) {
      assert.equal((await pedir(ctx, '/api/v1/admin/empresa', { token })).estado, 401);
      assert.equal((await pedir(ctx, '/api/v1/admin/empresa/prueba', { token })).estado, 401);
    }
  });

  test('un cambio de rol aplica de inmediato', async () => {
    const otro = await registrarEmpresa(ctx, { correo: 'admin@c.co', nit: '333' });
    await ctx.pool.query("UPDATE usuarios SET rol = 'cliente', empresa_id = NULL WHERE id = $1", [otro.json.usuario.id]);
    assert.equal((await verEmpresa(otro.json.token)).estado, 403);
  });
});

// S4 — el bloqueo también cubre el endpoint de administrador del personal
describe('prueba vencida y cancelación de citas del personal', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  test('el admin del personal no puede cancelar citas si la prueba de su negocio venció', async () => {
    const cita = await pedir(ctx, '/api/v1/citas', { method: 'POST', body: reservaValida({ fecha: fechaEnDias(2) }) });
    assert.equal(cita.estado, 201);
    const token = await iniciarSesion(ctx, 'admin.a', '1234');

    await ctx.pool.query(
      "UPDATE empresas SET estado_suscripcion = 'trial', trial_ends_at = now() - interval '1 minute' WHERE id = 'emp_a'",
    );
    const bloqueada = await pedir(ctx, `/api/v1/citas/${cita.json.cita.id}/cancelar`, { method: 'PATCH', token });
    assert.equal(bloqueada.estado, 402);
    assert.deepEqual(bloqueada.json, { error: MENSAJE_PRUEBA_VENCIDA });

    // Las funciones que no son de administrador siguen disponibles
    assert.equal((await pedir(ctx, '/api/v1/citas/agenda', { token })).estado, 200);

    await ctx.pool.query("UPDATE empresas SET estado_suscripcion = 'activa' WHERE id = 'emp_a'");
    const permitida = await pedir(ctx, `/api/v1/citas/${cita.json.cita.id}/cancelar`, { method: 'PATCH', token });
    assert.equal(permitida.estado, 200);
  });

  test('una suscripción cancelada o vencida también bloquea, con su propio mensaje', async () => {
    const token = await iniciarSesion(ctx, 'admin.b', 'clave-b');
    const mensajes = {
      cancelada: 'La suscripción de tu empresa está cancelada. Actívala para seguir usando las funciones de administrador.',
      vencida: 'La suscripción de tu empresa venció. Renuévala para seguir usando las funciones de administrador.',
    };
    for (const [estado, error] of Object.entries(mensajes)) {
      await ctx.pool.query('UPDATE empresas SET estado_suscripcion = $1 WHERE id = $2', [estado, 'emp_b']);
      const r = await pedir(ctx, '/api/v1/citas/cita_b/cancelar', { method: 'PATCH', token });
      assert.equal(r.estado, 402);
      assert.deepEqual(r.json, { error });
    }
  });
});
