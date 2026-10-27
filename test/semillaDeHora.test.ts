import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { type Contexto, iniciar } from './apoyo/servidor.js';

// T1-4 — las filas sembradas antes de la migración 024 (created_at sin zona) se interpretan como hora de Bogotá,
// como en producción; si la semilla las escribiera en UTC quedarían 5 horas en el futuro.
describe('hora de las filas sembradas', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  for (const tabla of ['empresas', 'barberos', 'servicios', 'clientes', 'citas']) {
    test(`${tabla}: ninguna fila sembrada tiene created_at en el futuro`, async () => {
      const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM ${tabla} WHERE created_at > now() + interval '1 minute'`);
      assert.equal(rows[0].n, 0);
    });
  }
});
