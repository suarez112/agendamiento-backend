import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { crearApp } from '../src/app.js';
import { cargarEntorno } from '../src/config/entorno.js';
import { type Contexto, iniciar, pedir, SECRETO_PRUEBAS } from './apoyo/servidor.js';

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
    const r = await pedir(ctx, '/api/saludo');
    assert.equal(r.estado, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-powered-by'), null);
  });
});

test('la comprobación de salud informa la caída de la base con su mensaje de siempre', async () => {
  const poolCaido = { query: async () => Promise.reject(new Error('connect ECONNREFUSED')) } as unknown as pg.Pool;
  const entorno = cargarEntorno({ ...process.env, NODE_ENV: 'test', JWT_SECRET: SECRETO_PRUEBAS });
  const servidor = crearApp({ pool: poolCaido, entorno }).listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  try {
    const { port } = servidor.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}/api/saludo`);
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'Error de conexión con la base de datos' });
  } finally {
    servidor.close();
  }
});

describe('CORS en producción', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar({ entorno: { NODE_ENV: 'production', CORS_ORIGINS: ['https://app.ejemplo.com'] } });
  });
  after(() => ctx.cerrar());

  test('permite el origen configurado', async () => {
    const r = await pedir(ctx, '/api/saludo', { headers: { Origin: 'https://app.ejemplo.com' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.ejemplo.com');
  });

  test('no autoriza otros orígenes', async () => {
    const r = await pedir(ctx, '/api/saludo', { headers: { Origin: 'https://malicioso.com' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });

  test('las apps nativas (sin Origin) siguen funcionando', async () => {
    assert.equal((await pedir(ctx, '/api/saludo')).estado, 200);
  });
});
