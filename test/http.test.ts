import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { type Contexto, iniciar, pedir } from './apoyo/servidor.js';

// S10 — manejo de errores, CORS y encabezados de seguridad
describe('manejo de errores', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  test('un JSON mal formado responde 400 en JSON sin detalles internos', async () => {
    const r = await pedir(ctx, '/api/v1/auth/login', { method: 'POST', cuerpoCrudo: '{"usuario": ' });
    assert.equal(r.estado, 400);
    assert.equal(r.json?.error, 'El cuerpo de la solicitud no es un JSON válido');
    assert.ok(!/at |node_modules|SyntaxError/.test(r.texto));
  });

  test('un cuerpo demasiado grande responde 413', async () => {
    const r = await pedir(ctx, '/api/v1/citas', { method: 'POST', body: { nombre: 'x'.repeat(20_000) } });
    assert.equal(r.estado, 413);
    assert.equal(r.json?.error, 'La solicitud es demasiado grande');
  });

  test('una ruta inexistente responde 404 en JSON', async () => {
    const r = await pedir(ctx, '/api/v1/no-existe');
    assert.equal(r.estado, 404);
    assert.equal(r.json?.error, 'Ruta no encontrada');
  });

  test('incluye encabezados de seguridad y oculta la tecnología', async () => {
    const r = await pedir(ctx, '/api/v1/planes');
    assert.equal(r.estado, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-powered-by'), null);
  });
});

// B-11: la comprobación /api/saludo no la usa nadie (ni la app) y revelaba la hora de la base y su estado
test('/api/saludo ya no existe', async () => {
  const ctx = await iniciar();
  try {
    const r = await pedir(ctx, '/api/saludo');
    assert.equal(r.estado, 404);
    assert.deepEqual(r.json, { error: 'Ruta no encontrada' });
  } finally {
    await ctx.cerrar();
  }
});

describe('CORS en producción', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar({ entorno: { NODE_ENV: 'production', CORS_ORIGINS: ['https://app.ejemplo.com'] } });
  });
  after(() => ctx.cerrar());

  test('permite el origen configurado', async () => {
    const r = await pedir(ctx, '/api/v1/planes', { headers: { Origin: 'https://app.ejemplo.com' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.ejemplo.com');
  });

  // M-8: la verificación previa del navegador debe aceptar PUT y DELETE (fotos, dispositivos, intervalo, borrados)
  for (const metodo of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    test(`la verificación previa (OPTIONS) permite ${metodo} desde el origen configurado`, async () => {
      const r = await pedir(ctx, '/api/v1/dispositivos', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.ejemplo.com',
          'Access-Control-Request-Method': metodo,
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      });
      assert.equal(r.estado, 204);
      assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.ejemplo.com');
      assert.ok(r.headers.get('access-control-allow-methods')?.split(',').includes(metodo), r.headers.get('access-control-allow-methods') ?? '');
    });
  }

  test('la verificación previa no autoriza a un origen desconocido', async () => {
    const r = await pedir(ctx, '/api/v1/dispositivos', {
      method: 'OPTIONS',
      headers: { Origin: 'https://malicioso.com', 'Access-Control-Request-Method': 'DELETE' },
    });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });

  test('no autoriza otros orígenes', async () => {
    const r = await pedir(ctx, '/api/v1/planes', { headers: { Origin: 'https://malicioso.com' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });

  test('las apps nativas (sin Origin) siguen funcionando', async () => {
    assert.equal((await pedir(ctx, '/api/v1/planes')).estado, 200);
  });
});
