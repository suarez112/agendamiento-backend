import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  CLAVE_CLIENTE,
  type Contexto,
  horarioValido,
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
const SOLO_PERSONAL = 'Esta función es solo para el personal del negocio.';
const SOLO_ADMIN_NEGOCIO = 'Solo el administrador del negocio puede usar esta función.';

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
    const a = await registrarEmpresa(ctx, { correo: 'admin@a.co', codigoAcceso: 'EMPA' });
    const b = await registrarEmpresa(ctx, { correo: 'admin@b.co', codigoAcceso: 'EMPB', nombre: 'Empresa B' });
    const cliente = await registrarCliente(ctx, 'cliente@correo.com', CLAVE_CLIENTE);
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

  // Los días se cuentan como días de calendario en la zona del negocio: fin - hoy (el día del fin ya es 0)
  const finDePruebaEl = (empresaId: string, fecha: string) =>
    ctx.pool.query(
      `UPDATE empresas SET trial_ends_at = ($2::date + time '12:00') AT TIME ZONE zona_horaria WHERE id = $1`,
      [empresaId, fecha],
    );

  test('cuenta los días de calendario que quedan en la zona del negocio', async () => {
    await finDePruebaEl(empresaA, fechaEnDias(12));
    assert.equal((await prueba(tokenA)).json.diasRestantes, 12);
    await finDePruebaEl(empresaA, fechaEnDias(1));
    assert.equal((await prueba(tokenA)).json.diasRestantes, 1);
    // El día del fin ya cuenta 0 y la prueba está vencida
    await finDePruebaEl(empresaA, fechaEnDias(0));
    const hoy = await prueba(tokenA);
    assert.equal(hoy.json.diasRestantes, 0);
    assert.equal(hoy.json.pruebaVencida, true);
  });

  test('cuando la prueba vence bloquea la gestión del negocio con un mensaje claro, pero deja usar Mi negocio y la suscripción', async () => {
    await finDePrueba(empresaA, '-1 minute');

    // Equipo, servicios, productos, bloqueos, clientes, cartera y agenda: 402 con el mensaje de prueba vencida
    for (const ruta of ['/api/v1/equipo', '/api/v1/servicios', '/api/v1/productos', '/api/v1/bloqueos', '/api/v1/clientes', '/api/v1/citas/agenda', '/api/v1/cartera?desde=2026-01-01&hasta=2026-01-31']) {
      const r = await pedir(ctx, ruta, { token: tokenA });
      assert.equal(r.estado, 402, ruta);
      assert.deepEqual(r.json, { error: MENSAJE_PRUEBA_VENCIDA }, ruta);
    }
    const crear = await pedir(ctx, '/api/v1/servicios', {
      method: 'POST',
      token: tokenA,
      body: { nombre: 'Corte', duracionMin: 30, precio: 20000 },
    });
    assert.equal(crear.estado, 402);
    const servicios = await ctx.pool.query('SELECT count(*)::int AS n FROM servicios WHERE empresa_id = $1', [empresaA]);
    assert.equal(servicios.rows[0].n, 0, 'no se creó nada');

    // Mi negocio y la suscripción siguen disponibles para poder renovar
    assert.equal((await verEmpresa(tokenA)).estado, 200);
    const editar = await editarEmpresa(tokenA, { direccion: 'Calle nueva 1' });
    assert.equal(editar.estado, 200);
    const suscripcion = await pedir(ctx, '/api/v1/admin/empresa/suscripcion', { token: tokenA });
    assert.equal(suscripcion.estado, 200);
    assert.equal(suscripcion.json.estado, 'vencida');
    assert.equal(suscripcion.json.diasRestantes, 0);

    // La otra empresa sigue en prueba y no se ve afectada
    assert.equal((await pedir(ctx, '/api/v1/servicios', { token: tokenB })).estado, 200);
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
    assert.equal(a.json.codigoAcceso, 'EMPA');
    assert.deepEqual(a.json.diasAtencion, [1, 2, 3, 4, 5, 6]);
    assert.equal(a.json.horarioApertura, '08:00');
    assert.equal(a.json.horarioCierre, '19:00');
    assert.deepEqual(a.json.horario, horarioValido().map((d) => ({ apertura: null, cierre: null, ...d })));
    assert.equal(a.json.estadoSuscripcion, 'trial');
    assert.equal(a.json.password_hash, undefined);
    // Contrato actual: el negocio ya no guarda NIT, teléfono ni correo
    assert.deepEqual([a.json.nit, a.json.correo, a.json.telefono], [undefined, undefined, undefined]);

    const b = await verEmpresa(tokenB);
    assert.equal(b.json.id, empresaB);
    assert.equal(b.json.nombre, 'Empresa B');
  });

  test('el admin modifica solo su empresa, aunque envíe el id de otra', async () => {
    const nuevoHorario = horarioValido('08:00', '20:30');
    const r = await editarEmpresa(tokenA, {
      id: empresaB,
      empresaId: empresaB,
      departamento: 'Antioquia',
      ciudad: 'Medellín',
      numeroEmpleados: 7,
      horario: nuevoHorario,
      estadoSuscripcion: 'activa',
      trialEndsAt: '2099-01-01',
    });
    assert.equal(r.estado, 200);
    assert.equal(r.json.id, empresaA);
    assert.equal(r.json.ciudad, 'MEDELLÍN');
    assert.equal(r.json.departamento, 'ANTIOQUIA');
    assert.equal(r.json.numeroEmpleados, 7);
    assert.equal(r.json.horarioCierre, '20:30');
    assert.equal(r.json.estadoSuscripcion, 'trial', 'no puede activarse la suscripción a sí mismo');

    const { rows } = await ctx.pool.query(
      'SELECT id, ciudad, numero_empleados, estado_suscripcion FROM empresas WHERE id = ANY($1) ORDER BY id = $2 DESC',
      [[empresaA, empresaB], empresaA],
    );
    assert.deepEqual(rows[0], { id: empresaA, ciudad: 'MEDELLÍN', numero_empleados: 7, estado_suscripcion: 'trial' });
    assert.deepEqual(rows[1], { id: empresaB, ciudad: 'BUCARAMANGA', numero_empleados: 4, estado_suscripcion: 'trial' });
    // El horario de B tampoco cambió
    const horarioB = await ctx.pool.query(
      "SELECT to_char(max(hora_cierre), 'HH24:MI') AS cierre FROM horarios_empresa WHERE empresa_id = $1",
      [empresaB],
    );
    assert.equal(horarioB.rows[0].cierre, '19:00');
  });

  test('la edición aplica las mismas validaciones del registro', async () => {
    const cierreAntes = horarioValido('21:00', '20:00');
    const casos: [unknown, number, string][] = [
      [{}, 400, 'Envía al menos un dato para actualizar'],
      [{ horario: cierreAntes }, 400, 'El lunes, la hora de cierre debe ser posterior a la de apertura'],
      [{ numeroEmpleados: 0 }, 400, 'El número de empleados debe ser un número entero entre 1 y 10'],
      [{ nombre: '' }, 400, 'El campo "nombre" es obligatorio'],
      [{ ciudad: 'Cali' }, 400, 'Envía el departamento y la ciudad juntos'],
      [{ departamento: 'Atlantida', ciudad: 'Cali' }, 400, 'El departamento no es un departamento de Colombia'],
      [{ departamento: 'Santander', ciudad: 'Cali' }, 400, 'La ciudad no es un municipio de ese departamento'],
      [{ codigoAcceso: 'con espacios' }, 400, 'El código del negocio solo puede tener letras (sin tildes ni ñ) y números, sin espacios, máximo 10 caracteres'],
      // El código de otro negocio no se puede tomar
      [{ codigoAcceso: 'empb' }, 409, 'Ese código ya lo usa otro negocio. Elige otro.'],
      // El correo y el usuario de acceso de la administradora no se cambian aquí: se ignoran
      [{ correo: 'no-es-correo', usuario: 'otro.usuario', clave: 'x' }, 400, 'Envía al menos un dato para actualizar'],
    ];
    for (const [cuerpo, estado, error] of casos) {
      const r = await editarEmpresa(tokenA, cuerpo);
      assert.equal(r.estado, estado, JSON.stringify(cuerpo));
      assert.deepEqual(r.json, { error });
    }
    // Enviar el mismo código de siempre no es un error
    const mismoCodigo = await editarEmpresa(tokenA, { codigoAcceso: 'empa' });
    assert.equal(mismoCodigo.estado, 200);
    assert.equal(mismoCodigo.json.codigoAcceso, 'EMPA');
  });

  test('un cliente no puede usar los endpoints de administrador', async () => {
    for (const r of [
      await verEmpresa(tokenCliente),
      await editarEmpresa(tokenCliente, { direccion: 'Calle nueva 1' }),
      await prueba(tokenCliente),
    ]) {
      assert.equal(r.estado, 403);
      assert.deepEqual(r.json, { error: SOLO_PERSONAL });
    }
  });

  test('sin sesión o con un token falso responde 401; un empleado recibe 403 y el admin del personal entra', async () => {
    for (const token of [undefined, 'token-falso']) {
      assert.equal((await pedir(ctx, '/api/v1/admin/empresa', { token })).estado, 401);
      assert.equal((await pedir(ctx, '/api/v1/admin/empresa/prueba', { token })).estado, 401);
    }
    // Un empleado del personal (no administrador) no puede usar Mi negocio
    const empleado = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    for (const ruta of ['/api/v1/admin/empresa', '/api/v1/admin/empresa/prueba']) {
      const r = await pedir(ctx, ruta, { token: empleado });
      assert.equal(r.estado, 403, ruta);
      assert.deepEqual(r.json, { error: SOLO_ADMIN_NEGOCIO });
    }
    // Un integrante con rol Administrador tiene los mismos permisos que la cuenta admin, sobre SU negocio
    const adminDelPersonal = await iniciarSesion(ctx, 'admin.a', '1234');
    const propio = await pedir(ctx, '/api/v1/admin/empresa', { token: adminDelPersonal });
    assert.equal(propio.estado, 200);
    assert.equal(propio.json.id, 'emp_a');
  });

  test('un cambio de rol aplica de inmediato', async () => {
    const otro = await registrarEmpresa(ctx, { correo: 'admin@c.co' });
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

    // La agenda también exige suscripción vigente; Mi negocio y la suscripción siguen disponibles
    const agenda = await pedir(ctx, '/api/v1/citas/agenda', { token });
    assert.equal(agenda.estado, 402);
    assert.deepEqual(agenda.json, { error: MENSAJE_PRUEBA_VENCIDA });
    assert.equal((await pedir(ctx, '/api/v1/admin/empresa/suscripcion', { token })).estado, 200);

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
