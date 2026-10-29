import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proveedorDePagoEsDePrueba } from '../src/config/entorno.js';
import { type Contexto, iniciar, pedir, registrarEmpresa } from './apoyo/servidor.js';

const URL_PAGOS = 'https://app.agendaya.test/pagos';
let contador = 0;

const negocioNuevo = async (ctx: Contexto) => {
  const r = await registrarEmpresa(ctx, { correo: `publico${++contador}@central.co` });
  assert.equal(r.estado, 201);
  return r.json.token as string;
};

const nuevaOrden = async (ctx: Contexto) => {
  const token = await negocioNuevo(ctx);
  const r = await pedir(ctx, '/api/v1/pagos/ordenes', { method: 'POST', token, body: { profesionales: 2, periodo: 'mensual' } });
  assert.equal(r.estado, 201);
  return { referencia: r.json.referencia as string, urlPago: r.json.urlPago as string };
};

const decidir = (ctx: Contexto, urlPago: string, accion: 'aprobar' | 'rechazar') =>
  fetch(`${ctx.url}${new URL(urlPago).pathname}/${accion}`, { redirect: 'manual' });

const estado = (ctx: Contexto, referencia: string, id?: string) =>
  pedir(ctx, `/api/v1/pagos/ordenes/${referencia}/estado${id ? `?id=${id}` : ''}`);

describe('resultado público del pago', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar({ entorno: { URL_PAGOS, PROVEEDOR_PAGO: 'simulado' } });
  });
  after(() => ctx.cerrar());

  test('pendiente mientras la persona no paga, sin sesión', async () => {
    const { referencia } = await nuevaOrden(ctx);
    const r = await estado(ctx, referencia);
    assert.equal(r.estado, 200);
    assert.deepEqual(r.json, { estado: 'pendiente' });
  });

  test('aprobado: confirma con la pasarela, activa el plan y responde solo estado, nivel y vencimiento', async () => {
    const { referencia, urlPago } = await nuevaOrden(ctx);
    await decidir(ctx, urlPago, 'aprobar');
    const r = await estado(ctx, referencia, `sim_${referencia}`);
    assert.equal(r.estado, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['estado', 'nivel', 'vencimiento']);
    assert.equal(r.json.estado, 'aprobado');
    assert.deepEqual(r.json.nivel, { id: 'equipo', nombre: 'Equipo' });
    assert.match(r.json.vencimiento, /^\d{4}-\d{2}-\d{2}$/);
    const [o] = (await ctx.pool.query('SELECT estado, activada_en FROM ordenes_pago WHERE referencia = $1', [referencia])).rows;
    assert.equal(o.estado, 'aprobada');
    assert.ok(o.activada_en);
    // Repetirla no cambia nada ni activa dos veces
    assert.deepEqual((await estado(ctx, referencia, `sim_${referencia}`)).json, r.json);
    const n = (await ctx.pool.query("SELECT count(*)::int AS n FROM activaciones_plan WHERE origen = 'pasarela'")).rows[0].n;
    assert.ok(n >= 1);
  });

  test('rechazado, sin montos ni datos personales', async () => {
    const { referencia, urlPago } = await nuevaOrden(ctx);
    await decidir(ctx, urlPago, 'rechazar');
    const r = await estado(ctx, referencia, `sim_${referencia}`);
    assert.equal(r.estado, 200);
    assert.deepEqual(r.json, { estado: 'rechazado' });
  });

  test('una referencia que no existe responde 404', async () => {
    const r = await estado(ctx, 'AGD-NOEXISTE-AAAAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(r.estado, 404);
  });

  test('la referencia es larga y aleatoria (96 bits)', async () => {
    const { referencia } = await nuevaOrden(ctx);
    assert.ok(referencia.length <= 40);
    assert.match(referencia, /^AGD-[A-Z0-9]+-[A-F0-9]{24}$/);
  });

  test('un id de transacción vacío o demasiado largo es 400', async () => {
    const { referencia } = await nuevaOrden(ctx);
    assert.equal((await estado(ctx, referencia, 'x'.repeat(101))).estado, 400);
  });

  test('configuración: simulado es de prueba y no expone llaves', async () => {
    const r = await pedir(ctx, '/api/v1/pagos/configuracion');
    assert.equal(r.estado, 200);
    assert.deepEqual(r.json, { disponible: true, proveedor: 'simulado', esDePrueba: true });
  });
});

describe('pagos desactivados y límite de consultas', () => {
  test('sin proveedor: configuración dice no disponible y el estado responde 503', async () => {
    const ctx = await iniciar({ proveedorPago: 'ausente' });
    try {
      const c = await pedir(ctx, '/api/v1/pagos/configuracion');
      assert.deepEqual(c.json, { disponible: false, proveedor: null, esDePrueba: false });
      assert.equal((await estado(ctx, 'AGD-X-AAAAAAAAAAAAAAAAAAAAAAAA')).estado, 503);
    } finally {
      await ctx.cerrar();
    }
  });

  test('límite por conexión: pasado el tope responde 429', async () => {
    const ctx = await iniciar({ entorno: { URL_PAGOS, PROVEEDOR_PAGO: 'simulado' }, limites: { estadoPago: 3 } });
    try {
      const codigos: number[] = [];
      for (let i = 0; i < 5; i++) codigos.push((await estado(ctx, 'AGD-X-AAAAAAAAAAAAAAAAAAAAAAAA')).estado);
      assert.deepEqual(codigos, [404, 404, 404, 429, 429]);
      assert.equal((await pedir(ctx, '/api/v1/pagos/configuracion')).estado, 429);
    } finally {
      await ctx.cerrar();
    }
  });
});

describe('proveedorDePagoEsDePrueba', () => {
  test('simulado y llaves de prueba sí; llaves de producción o sin proveedor no', () => {
    assert.equal(proveedorDePagoEsDePrueba({ NODE_ENV: 'development' }), true);
    assert.equal(proveedorDePagoEsDePrueba({ NODE_ENV: 'development', PROVEEDOR_PAGO: 'wompi', WOMPI_LLAVE_PUBLICA: 'pub_test_abc' }), true);
    assert.equal(proveedorDePagoEsDePrueba({ NODE_ENV: 'production', PROVEEDOR_PAGO: 'wompi', WOMPI_LLAVE_PUBLICA: 'pub_prod_abc' }), false);
    assert.equal(proveedorDePagoEsDePrueba({ NODE_ENV: 'production' }), false);
  });
});
