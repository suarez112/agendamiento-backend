import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import type pg from 'pg';
import { cargarEntorno } from '../src/config/entorno.js';
import { crearRutaSalud } from '../src/shared/http/salud.js';
import { type Contexto, iniciar, pedir } from './apoyo/servidor.js';

// Despliegue en Render: comprobación de salud y variables opcionales que llegan vacías

describe('GET /salud', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar({ limites: { general: 1 } });
  });
  after(() => ctx.cerrar());

  test('responde 200 { estado: "ok" } sin revelar nada más', async () => {
    const r = await pedir(ctx, '/salud');
    assert.equal(r.estado, 200);
    assert.deepEqual(r.json, { estado: 'ok' });
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  test('no la frena el límite general de /api (Render la consulta cada pocos segundos)', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await pedir(ctx, '/salud');
      assert.equal(r.estado, 200);
    }
  });
});

test('GET /salud responde 503 sin detalles si la base de datos no contesta', async () => {
  const poolCaido = { query: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:5432')) } as unknown as pg.Pool;
  const app = express();
  app.use('/salud', crearRutaSalud(poolCaido));
  const servidor = await new Promise<ReturnType<typeof app.listen>>((resolver) => {
    const s = app.listen(0, '127.0.0.1', () => resolver(s));
  });
  try {
    const { port } = servidor.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}/salud`);
    assert.equal(r.status, 503);
    const texto = await r.text();
    assert.deepEqual(JSON.parse(texto), { error: 'Servicio no disponible' });
    assert.ok(!/ECONNREFUSED|10\.0\.0\.1/.test(texto));
  } finally {
    await new Promise((r) => servidor.close(r));
  }
});

describe('variables opcionales vacías', () => {
  const BASE = {
    NODE_ENV: 'production',
    DB_HOST: 'localhost',
    DB_USER: 'u',
    DB_PASSWORD: 'p',
    DB_NAME: 'n',
    JWT_SECRET: 'a'.repeat(40),
    RECUPERACION_SECRET: 'b'.repeat(40),
    TOTP_SECRET: 'c'.repeat(40),
  };

  test('EXPO_ACCESS_TOKEN y URL_PAGOS vacías cuentan como no definidas (Render puede dejarlas en blanco)', () => {
    const e = cargarEntorno({ ...BASE, EXPO_ACCESS_TOKEN: '', URL_PAGOS: '  ' } as NodeJS.ProcessEnv);
    assert.equal(e.EXPO_ACCESS_TOKEN, undefined);
    assert.equal(e.URL_PAGOS, undefined);
  });

  test('con valor siguen validándose como antes', () => {
    const e = cargarEntorno({ ...BASE, EXPO_ACCESS_TOKEN: 'tok', URL_PAGOS: 'https://agendality.com/pagos/' } as NodeJS.ProcessEnv);
    assert.equal(e.EXPO_ACCESS_TOKEN, 'tok');
    assert.equal(e.URL_PAGOS, 'https://agendality.com/pagos');
    assert.throws(() => cargarEntorno({ ...BASE, URL_PAGOS: 'agendality' } as NodeJS.ProcessEnv), /URL_PAGOS/);
  });
});
