import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { type Contexto, iniciar, iniciarSesion, pedir, reservaValida } from './apoyo/servidor.js';
import { fechaEnDias } from './apoyo/baseDePrueba.js';

// S6, S7, S8 — permisos por rol y aislamiento entre negocios
describe('permisos y aislamiento entre negocios', () => {
  let ctx: Contexto;
  let tokenAdminA: string;
  let tokenBarberoA: string;
  let tokenBarberoA2: string;
  let citaDeBarberoA: string;
  let citaDeBarberoA2: string;

  before(async () => {
    ctx = await iniciar();
    tokenAdminA = await iniciarSesion(ctx, 'admin.a', '1234');
    tokenBarberoA = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    tokenBarberoA2 = await iniciarSesion(ctx, 'barbero.a2', 'secreta');
    const fecha = fechaEnDias(3);
    const c1 = await pedir(ctx, '/api/v1/citas', { method: 'POST', body: reservaValida({ fecha }) });
    const c2 = await pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      body: reservaValida({ fecha, barberoId: 'barb_a2', telefono: '3110000000' }),
    });
    assert.equal(c1.estado, 201);
    assert.equal(c2.estado, 201);
    citaDeBarberoA = c1.json.cita.id;
    citaDeBarberoA2 = c2.json.cita.id;
  });
  after(() => ctx.cerrar());

  test('la agenda exige sesión', async () => {
    const r = await pedir(ctx, '/api/v1/citas/agenda');
    assert.equal(r.estado, 401);
  });

  test('el admin ve solo las citas de su negocio', async () => {
    const r = await pedir(ctx, '/api/v1/citas/agenda', { token: tokenAdminA });
    assert.equal(r.estado, 200);
    const ids = r.json.map((c: { id: string }) => c.id);
    assert.ok(ids.includes(citaDeBarberoA) && ids.includes(citaDeBarberoA2));
    assert.ok(!ids.includes('cita_b'), 'no ve citas del negocio B');
    assert.ok(r.json.every((c: { empresaId: string }) => c.empresaId === 'emp_a'));
  });

  test('un barbero ve solo sus propias citas', async () => {
    const r = await pedir(ctx, '/api/v1/citas/agenda', { token: tokenBarberoA });
    assert.equal(r.estado, 200);
    assert.deepEqual(
      r.json.map((c: { id: string }) => c.id),
      [citaDeBarberoA],
    );
  });

  test('un barbero no puede completar la cita de otro', async () => {
    const r = await pedir(ctx, `/api/v1/citas/${citaDeBarberoA}/completar`, { method: 'PATCH', token: tokenBarberoA2 });
    assert.equal(r.estado, 409);
    const { rows } = await ctx.pool.query('SELECT estado FROM citas WHERE id = $1', [citaDeBarberoA]);
    assert.equal(rows[0].estado, 'CONFIRMADA');
  });

  test('un barbero no puede cancelar citas (solo el admin)', async () => {
    const r = await pedir(ctx, `/api/v1/citas/${citaDeBarberoA}/cancelar`, { method: 'PATCH', token: tokenBarberoA });
    assert.equal(r.estado, 403);
    assert.equal(r.json.error, 'Solo el administrador puede cancelar citas.');
  });

  test('el admin de A no puede cancelar ni completar citas del negocio B', async () => {
    const cancelar = await pedir(ctx, '/api/v1/citas/cita_b/cancelar', { method: 'PATCH', token: tokenAdminA });
    const completar = await pedir(ctx, '/api/v1/citas/cita_b/completar', { method: 'PATCH', token: tokenAdminA });
    assert.equal(cancelar.estado, 409);
    assert.equal(completar.estado, 409);
    const { rows } = await ctx.pool.query("SELECT estado FROM citas WHERE id = 'cita_b'");
    assert.equal(rows[0].estado, 'CONFIRMADA');
  });

  test('el dueño completa su cita y el admin cancela otra de su negocio', async () => {
    const completar = await pedir(ctx, `/api/v1/citas/${citaDeBarberoA}/completar`, { method: 'PATCH', token: tokenBarberoA });
    assert.equal(completar.estado, 200);
    assert.equal(completar.json.completadaPor, 'Barbero A');
    const cancelar = await pedir(ctx, `/api/v1/citas/${citaDeBarberoA2}/cancelar`, { method: 'PATCH', token: tokenAdminA });
    assert.equal(cancelar.estado, 200);
    assert.equal(cancelar.json.canceladaPor, 'Admin A');
  });

  test('no se puede reservar con un profesional o servicio de otro negocio', async () => {
    const conBarberoAjeno = await pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      body: reservaValida({ barberoId: 'admin_b', hora: '03:00 PM' }),
    });
    const conServicioAjeno = await pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      body: reservaValida({ servicioId: 'serv_b', hora: '03:00 PM' }),
    });
    assert.equal(conBarberoAjeno.estado, 404);
    assert.equal(conServicioAjeno.estado, 404);
  });

  test('la base rechaza una cita que mezcla negocios aunque la API fallara', async () => {
    await assert.rejects(
      ctx.pool.query(
        `INSERT INTO citas (id, empresa_id, barbero_id, servicio_id, cliente_id, fecha, hora_inicio, hora_fin, precio)
         VALUES ('mezcla', 'emp_a', 'admin_b', 'serv_a', 'cli_b', CURRENT_DATE + 30, '09:00', '09:30', 1)`,
      ),
      { code: '23503' },
    );
  });

  test('la vista pública del negocio no expone los usuarios de inicio de sesión', async () => {
    const r = await pedir(ctx, '/api/v1/empresas/validar/nega');
    assert.equal(r.estado, 200);
    assert.equal(r.json.empresa.id, 'emp_a');
    assert.ok(r.json.barberos.length > 0);
    assert.ok(r.json.barberos.every((b: { usuario: string; clave: string }) => b.usuario === '' && b.clave === ''));
    assert.ok(!r.texto.includes('password_hash') && !r.texto.includes('admin.a'));
  });

  test('el personal obtiene su propio negocio con usuarios mediante /empresas/actual', async () => {
    assert.equal((await pedir(ctx, '/api/v1/empresas/actual')).estado, 401);
    const r = await pedir(ctx, '/api/v1/empresas/actual', { token: tokenBarberoA });
    assert.equal(r.estado, 200);
    assert.equal(r.json.empresa.id, 'emp_a');
    assert.deepEqual(
      r.json.barberos.map((b: { usuario: string }) => b.usuario).sort(),
      ['admin.a', 'barbero.a', 'barbero.a2'],
    );
  });

  test('las horas ocupadas no incluyen datos personales de clientes', async () => {
    const r = await pedir(ctx, '/api/v1/citas/ocupadas?empresaId=emp_a');
    assert.equal(r.estado, 200);
    assert.ok(!r.texto.includes('Cliente Prueba') && !r.texto.includes('3001234567'));
  });
});
