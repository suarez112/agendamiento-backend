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
  registrarEmpresa,
  reservaValida,
} from './apoyo/servidor.js';
import * as repositorioCitas from '../src/modules/citas/citas.repositorio.js';
import * as repositorioEquipo from '../src/modules/equipo/equipo.repositorio.js';

// B-2 — el límite de registros no cuenta los intentos con errores de validación
describe('límite de registros', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar({ limites: { registro: 3 } });
  });
  after(() => ctx.cerrar());

  test('los errores de validación (400) no gastan el límite, y los registros que sí llegan a crear algo, sí', async () => {
    for (let i = 0; i < 6; i++) {
      assert.equal((await registrarEmpresa(ctx, { nombre: '' })).estado, 400, `intento inválido ${i}`);
      assert.equal((await registrarCliente(ctx, 'sin-clave@correo.com', 'x')).estado, 400);
    }
    for (let i = 0; i < 3; i++) {
      const r = await registrarEmpresa(ctx, { correo: `negocio${i}@central.co` });
      assert.equal(r.estado, 201, r.texto);
    }
    const bloqueado = await registrarEmpresa(ctx, { correo: 'negocio9@central.co' });
    assert.equal(bloqueado.estado, 429);
    assert.deepEqual(bloqueado.json, { error: 'Demasiados registros seguidos. Intenta de nuevo en unos minutos.' });
  });

  test('un registro rechazado por datos repetidos (409) sí cuenta: así no se puede comprobar sin límite quién existe', async () => {
    const otro = await iniciar({ limites: { registro: 3 } });
    try {
      assert.equal((await registrarCliente(otro, 'repetido@correo.com', CLAVE_CLIENTE)).estado, 201);
      assert.equal((await registrarCliente(otro, 'repetido@correo.com', CLAVE_CLIENTE)).estado, 409);
      assert.equal((await registrarCliente(otro, 'repetido@correo.com', CLAVE_CLIENTE)).estado, 409);
      assert.equal((await registrarCliente(otro, 'repetido@correo.com', CLAVE_CLIENTE)).estado, 429);
    } finally {
      await otro.cerrar();
    }
  });
});

// B-3 — cancelar una cita inexistente responde 404 antes de mirar la suscripción
describe('cancelar una cita que no existe', () => {
  let ctx: Contexto;
  let token: string;
  before(async () => {
    ctx = await iniciar();
    token = await iniciarSesion(ctx, 'admin.a', '1234');
  });
  after(() => ctx.cerrar());

  const cancelar = (id: string, t = token) => pedir(ctx, `/api/v1/citas/${id}/cancelar`, { method: 'PATCH', token: t });

  test('con la suscripción vigente: 404 si no existe o es de otro negocio, 409 solo si ya estaba atendida o cancelada', async () => {
    const inexistente = await cancelar('no-existe');
    assert.equal(inexistente.estado, 404);
    assert.deepEqual(inexistente.json, { error: 'Cita no encontrada' });
    const deOtroNegocio = await cancelar('cita_b');
    assert.equal(deOtroNegocio.estado, 404);

    const cita = await pedir(ctx, '/api/v1/citas', { method: 'POST', body: reservaValida({ fecha: fechaEnDias(2), telefono: '3100000401' }) });
    assert.equal((await cancelar(cita.json.cita.id)).estado, 200);
    const repetida = await cancelar(cita.json.cita.id);
    assert.equal(repetida.estado, 409);
    assert.deepEqual(repetida.json, { error: 'No se pudo cancelar: la cita ya fue atendida o cancelada.' });
  });

  test('con la suscripción vencida: una cita inexistente sigue siendo 404, no 402', async () => {
    const cita = await pedir(ctx, '/api/v1/citas', { method: 'POST', body: reservaValida({ fecha: fechaEnDias(3), telefono: '3100000402' }) });
    await ctx.pool.query("UPDATE empresas SET estado_suscripcion = 'trial', trial_ends_at = now() - interval '1 minute' WHERE id = 'emp_a'");
    assert.equal((await cancelar('no-existe')).estado, 404);
    assert.equal((await cancelar('cita_b')).estado, 404);
    assert.equal((await cancelar(cita.json.cita.id)).estado, 402, 'una cita que sí existe sigue pidiendo la suscripción');
  });
});

// B-10 — los UPDATE por id llevan además el filtro del negocio en la propia sentencia
describe('UPDATE con filtro de negocio', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  const citaB = async () => (await ctx.pool.query("SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, hora_inicio FROM citas WHERE id = 'cita_b'")).rows[0];

  test('moverCita no toca una cita de otro negocio', async () => {
    const antes = await citaB();
    const ajena = await repositorioCitas.moverCita(ctx.pool, { id: 'cita_b', empresaId: 'emp_a', fecha: fechaEnDias(9), horaInicio: '15:00', horaFin: '15:30' });
    assert.equal(ajena.rowCount, 0);
    assert.deepEqual(await citaB(), antes);
    const propia = await repositorioCitas.moverCita(ctx.pool, { id: 'cita_b', empresaId: 'emp_b', fecha: fechaEnDias(9), horaInicio: '15:00', horaFin: '15:30' });
    assert.equal(propia.rowCount, 1);
  });

  test('avanzarUltimaCita no toca a un cliente de otro negocio', async () => {
    const ultima = async () => (await ctx.pool.query("SELECT fecha_ultima_cita FROM clientes WHERE id = 'cli_b'")).rows[0];
    const antes = await ultima();
    assert.equal((await repositorioCitas.avanzarUltimaCita(ctx.pool, 'emp_a', 'cli_b', fechaEnDias(12))).rowCount, 0);
    assert.deepEqual(await ultima(), antes);
    assert.equal((await repositorioCitas.avanzarUltimaCita(ctx.pool, 'emp_b', 'cli_b', fechaEnDias(12))).rowCount, 1);
  });

  test('cambiarPerfilDeCuenta no toca a un profesional de otro negocio', async () => {
    const estado = async () => (await ctx.pool.query("SELECT activo, atiende_clientes FROM barberos WHERE id = 'admin_b'")).rows[0];
    const antes = await estado();
    assert.equal(await repositorioEquipo.cambiarPerfilDeCuenta(ctx.pool, 'emp_a', 'admin_b', false, false), undefined);
    assert.deepEqual(await estado(), antes);
    assert.ok(await repositorioEquipo.cambiarPerfilDeCuenta(ctx.pool, 'emp_b', 'admin_b', true, false));
  });
});
