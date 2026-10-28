import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fechaEnDias } from './apoyo/baseDePrueba.js';
import { type Contexto, esperarHasta, iniciar, iniciarSesion, pedir, reservaValida } from './apoyo/servidor.js';

// Marcar todas las notificaciones como leídas
describe('marcar todas las notificaciones como leídas', () => {
  let ctx: Contexto;
  let tokenA: string;
  let tokenB: string;
  before(async () => {
    ctx = await iniciar();
    tokenA = await iniciarSesion(ctx, 'admin.a', '1234');
    tokenB = await iniciarSesion(ctx, 'admin.b', 'clave-b');
  });
  after(() => ctx.cerrar());

  test('marca todas las de la persona, devuelve cuántas y no toca las de otra', async () => {
    for (const hora of ['09:00 AM', '09:30 AM']) {
      const r = await pedir(ctx, '/api/v1/citas', { method: 'POST', body: reservaValida({ fecha: fechaEnDias(3), hora, telefono: `31000007${hora.slice(0, 2)}` }) });
      assert.equal(r.estado, 201, r.texto);
    }
    await esperarHasta(async () => (await pedir(ctx, '/api/v1/notificaciones/no-leidas', { token: tokenA })).json.noLeidas >= 2);
    const total = (await pedir(ctx, '/api/v1/notificaciones/no-leidas', { token: tokenA })).json.noLeidas;
    // Que otra persona marque las suyas no toca las de A
    await pedir(ctx, '/api/v1/notificaciones/leidas', { method: 'PATCH', token: tokenB });
    assert.equal((await pedir(ctx, '/api/v1/notificaciones/no-leidas', { token: tokenA })).json.noLeidas, total);
    const r = await pedir(ctx, '/api/v1/notificaciones/leidas', { method: 'PATCH', token: tokenA });
    assert.equal(r.estado, 200);
    assert.deepEqual(r.json, { mensaje: 'Notificaciones marcadas como leídas', marcadas: total });
    assert.deepEqual((await pedir(ctx, '/api/v1/notificaciones/no-leidas', { token: tokenA })).json, { noLeidas: 0 });

    // Sin nada pendiente no marca ninguna; y sin sesión se rechaza
    assert.equal((await pedir(ctx, '/api/v1/notificaciones/leidas', { method: 'PATCH', token: tokenA })).json.marcadas, 0);
    assert.equal((await pedir(ctx, '/api/v1/notificaciones/leidas', { method: 'PATCH' })).estado, 401);
  });
});
