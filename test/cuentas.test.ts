import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  type Contexto,
  iniciar,
  iniciarSesion,
  iniciarSesionCuenta,
  pedir,
  registrarCliente,
  registrarEmpresa,
} from './apoyo/servidor.js';

// S1, S2, S3, S7 — registro de empresas y clientes, login de cuentas
describe('registro de empresa', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  const contarEmpresas = async () => Number((await ctx.pool.query('SELECT count(*) FROM empresas')).rows[0].count);
  const contarUsuarios = async () => Number((await ctx.pool.query('SELECT count(*) FROM usuarios')).rows[0].count);

  test('crea la empresa en prueba de 15 días y su administrador', async () => {
    const r = await registrarEmpresa(ctx);
    assert.equal(r.estado, 201);
    assert.equal(typeof r.json.token, 'string');
    assert.equal(r.json.usuario.correo, 'admin@central.co');
    assert.equal(r.json.usuario.rol, 'admin');
    assert.equal(r.json.usuario.empresaId, r.json.empresa.id);
    assert.equal(r.json.empresa.nombre, 'Barbería Central');
    assert.match(r.json.empresa.codigoAcceso, /^[A-Z0-9]{6}$/);
    assert.equal(r.json.empresa.estadoSuscripcion, 'trial');
    assert.equal(r.json.empresa.diasPruebaRestantes, 15);
    assert.equal(r.json.usuario.clave, undefined, 'nunca devuelve la contraseña');

    const { rows } = await ctx.pool.query(
      `SELECT e.estado_suscripcion, e.nit, e.dias_atencion, e.numero_empleados,
              e.horario_apertura, e.horario_cierre, e.nombre_administradora,
              e.trial_ends_at BETWEEN now() + interval '15 days' - interval '1 minute'
                                  AND now() + interval '15 days' AS prueba_15_dias,
              u.rol, u.password_hash
       FROM empresas e JOIN usuarios u ON u.empresa_id = e.id
       WHERE e.id = $1`,
      [r.json.empresa.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].estado_suscripcion, 'trial');
    assert.equal(rows[0].prueba_15_dias, true);
    assert.equal(rows[0].nit, '9001234567');
    assert.deepEqual(rows[0].dias_atencion, [1, 2, 3, 4, 5, 6]);
    assert.equal(rows[0].numero_empleados, 4);
    assert.equal(rows[0].horario_apertura, '08:00:00');
    assert.equal(rows[0].horario_cierre, '19:00:00');
    assert.equal(rows[0].nombre_administradora, 'Ana Pérez');
    assert.equal(rows[0].rol, 'admin');
    assert.match(rows[0].password_hash, /^\$2[aby]\$12\$/);

    // Los clientes ya pueden encontrar el negocio con su código
    const publico = await pedir(ctx, `/api/v1/empresas/validar/${r.json.empresa.codigoAcceso}`);
    assert.equal(publico.estado, 200);
    assert.equal(publico.json.empresa.id, r.json.empresa.id);
  });

  test('el NIT y el logo son opcionales', async () => {
    const r = await registrarEmpresa(ctx, { correo: 'sin-nit@central.co', nit: undefined, logoUrl: undefined });
    assert.equal(r.estado, 201);
  });

  test('exige los campos obligatorios', async () => {
    const antes = await contarEmpresas();
    const r = await registrarEmpresa(ctx, { correo: 'falta@central.co', ciudad: undefined });
    assert.equal(r.estado, 400);
    assert.deepEqual(r.json, { error: 'El campo "ciudad" es obligatorio' });

    const vacio = await registrarEmpresa(ctx, { correo: 'falta@central.co', nombre: '   ' });
    assert.equal(vacio.estado, 400);
    assert.deepEqual(vacio.json, { error: 'El campo "nombre" es obligatorio' });

    const sinCuerpo = await pedir(ctx, '/api/v1/cuentas/registro/empresa', { method: 'POST' });
    assert.equal(sinCuerpo.estado, 400);
    assert.equal(await contarEmpresas(), antes);
  });

  test('la hora de cierre debe ser posterior a la de apertura', async () => {
    for (const [apertura, cierre] of [
      ['18:00', '09:00'],
      ['09:00', '09:00'],
    ]) {
      const r = await registrarEmpresa(ctx, { correo: 'horas@central.co', horarioApertura: apertura, horarioCierre: cierre });
      assert.equal(r.estado, 400);
      assert.deepEqual(r.json, { error: 'La hora de cierre debe ser posterior a la hora de apertura' });
    }
    const formato = await registrarEmpresa(ctx, { correo: 'horas@central.co', horarioApertura: '8am' });
    assert.equal(formato.estado, 400);
    assert.deepEqual(formato.json, { error: 'La hora de apertura debe tener el formato HH:MM (24 horas)' });
  });

  test('el número de empleados debe ser un entero positivo', async () => {
    for (const numeroEmpleados of [0, -3, 2.5, '4']) {
      const r = await registrarEmpresa(ctx, { correo: 'empleados@central.co', numeroEmpleados });
      assert.equal(r.estado, 400, `numeroEmpleados=${numeroEmpleados}`);
      assert.deepEqual(r.json, { error: 'El número de empleados debe ser un número entero mayor que cero' });
    }
  });

  test('el correo debe ser válido', async () => {
    for (const correo of ['sin-arroba', 'a@b', 'dos@@arrobas.co']) {
      const r = await registrarEmpresa(ctx, { correo });
      assert.equal(r.estado, 400, `correo=${correo}`);
      assert.deepEqual(r.json, { error: 'El correo no es válido' });
    }
  });

  test('un correo o un NIT repetidos no crean nada', async () => {
    const empresas = await contarEmpresas();
    const usuarios = await contarUsuarios();

    // Mismo correo con otras mayúsculas: la empresa tampoco debe quedar creada
    const correo = await registrarEmpresa(ctx, { correo: 'ADMIN@Central.co', nit: '800111222-3' });
    assert.equal(correo.estado, 409);
    assert.deepEqual(correo.json, { error: 'Ya existe una cuenta con ese correo' });

    // Mismo NIT escrito de otra forma
    const nit = await registrarEmpresa(ctx, { correo: 'otro@central.co', nit: '900 123 456 7' });
    assert.equal(nit.estado, 409);
    assert.deepEqual(nit.json, { error: 'Ya existe una empresa registrada con ese NIT' });

    assert.equal(await contarEmpresas(), empresas);
    assert.equal(await contarUsuarios(), usuarios);
  });

  test('ignora campos que no le corresponde elegir al usuario', async () => {
    const r = await registrarEmpresa(ctx, {
      correo: 'astuto@central.co',
      nit: undefined,
      id: 'emp_a',
      estadoSuscripcion: 'activa',
      trialEndsAt: '2099-01-01',
      rol: 'cliente',
    });
    assert.equal(r.estado, 201);
    assert.notEqual(r.json.empresa.id, 'emp_a');
    assert.equal(r.json.empresa.estadoSuscripcion, 'trial');
    assert.equal(r.json.empresa.diasPruebaRestantes, 15);
    assert.equal(r.json.usuario.rol, 'admin');
  });
});

describe('cuentas de cliente y login', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
    assert.equal((await registrarEmpresa(ctx)).estado, 201);
  });
  after(() => ctx.cerrar());

  test('registra un cliente sin empresa', async () => {
    const r = await registrarCliente(ctx, '  Cliente@Correo.com ', 'mi-clave-123');
    assert.equal(r.estado, 201);
    assert.equal(typeof r.json.token, 'string');
    assert.deepEqual(
      { correo: r.json.usuario.correo, rol: r.json.usuario.rol, empresaId: r.json.usuario.empresaId },
      { correo: 'cliente@correo.com', rol: 'cliente', empresaId: null },
    );
    const { rows } = await ctx.pool.query('SELECT rol, empresa_id, password_hash FROM usuarios WHERE id = $1', [
      r.json.usuario.id,
    ]);
    assert.equal(rows[0].rol, 'cliente');
    assert.equal(rows[0].empresa_id, null);
    assert.match(rows[0].password_hash, /^\$2[aby]\$12\$/);
  });

  test('valida correo y contraseña del cliente', async () => {
    assert.deepEqual((await registrarCliente(ctx, 'malo', 'mi-clave-123')).json, { error: 'El correo no es válido' });
    const corta = await registrarCliente(ctx, 'nuevo@correo.com', 'corta');
    assert.equal(corta.estado, 400);
    assert.deepEqual(corta.json, { error: 'La contraseña debe tener entre 8 y 64 caracteres' });
    const faltan = await pedir(ctx, '/api/v1/cuentas/registro/cliente', { method: 'POST', body: {} });
    assert.equal(faltan.estado, 400);
  });

  test('no permite dos cuentas con el mismo correo', async () => {
    const r = await registrarCliente(ctx, 'CLIENTE@correo.com', 'otra-clave-123');
    assert.equal(r.estado, 409);
    assert.deepEqual(r.json, { error: 'Ya existe una cuenta con ese correo' });
    // Tampoco con el correo del administrador de una empresa
    assert.equal((await registrarCliente(ctx, 'admin@central.co', 'otra-clave-123')).estado, 409);
  });

  test('el cliente inicia sesión con correo y contraseña', async () => {
    const r = await iniciarSesionCuenta(ctx, 'cliente@CORREO.com', 'mi-clave-123');
    assert.equal(r.estado, 200);
    assert.equal(typeof r.json.token, 'string');
    assert.equal(r.json.usuario.rol, 'cliente');
    assert.equal(r.json.usuario.empresaId, null);
  });

  test('el administrador inicia sesión con el correo de la empresa', async () => {
    const r = await iniciarSesionCuenta(ctx, 'admin@central.co', 'clave-segura-123');
    assert.equal(r.estado, 200);
    assert.equal(r.json.usuario.rol, 'admin');
    assert.equal(typeof r.json.usuario.empresaId, 'string');
  });

  test('correo inexistente y contraseña incorrecta responden igual', async () => {
    const incorrecta = await iniciarSesionCuenta(ctx, 'cliente@correo.com', 'no-es-la-clave');
    const inexistente = await iniciarSesionCuenta(ctx, 'nadie@correo.com', 'no-es-la-clave');
    assert.equal(incorrecta.estado, 401);
    assert.deepEqual(incorrecta.json, { error: 'Correo o contraseña incorrectos' });
    assert.deepEqual(inexistente.json, incorrecta.json);
    assert.equal((await iniciarSesionCuenta(ctx, 'cliente@correo.com', undefined)).estado, 400);
  });

  test('el token de una cuenta no sirve en los endpoints del personal, ni al revés', async () => {
    const cliente = (await iniciarSesionCuenta(ctx, 'cliente@correo.com', 'mi-clave-123')).json.token;
    const admin = (await iniciarSesionCuenta(ctx, 'admin@central.co', 'clave-segura-123')).json.token;
    for (const token of [cliente, admin]) {
      assert.equal((await pedir(ctx, '/api/v1/citas/agenda', { token })).estado, 401);
      assert.equal((await pedir(ctx, '/api/v1/empresas/actual', { token })).estado, 401);
    }
    // El login del personal (barberos) sigue igual
    assert.equal(typeof (await iniciarSesion(ctx, 'admin.a', '1234')), 'string');
  });
});
