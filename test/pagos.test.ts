import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { precioPara } from '../src/config/planes.js';
import { crearServicioPagos } from '../src/modules/pagos/pagos.servicio.js';
import type { ProveedorPago, ResultadoPago } from '../src/modules/pagos/proveedor.js';
import { crearProveedorWompi } from '../src/modules/pagos/proveedorWompi.js';
import { type Contexto, crearSuperadmin, iniciar, iniciarSesion, pedir, registrarEmpresa } from './apoyo/servidor.js';

const URL_PAGOS = 'https://app.agendaya.test/pagos';

// Registra un negocio nuevo (en prueba) y devuelve su token de administradora
let contadorCorreo = 0;
const negocioNuevo = async (ctx: Contexto) => {
  const r = await registrarEmpresa(ctx, { correo: `pagos${++contadorCorreo}@central.co` });
  assert.equal(r.estado, 201);
  return { token: r.json.token as string, empresaId: r.json.empresa.id as string };
};

const crearOrden = (ctx: Contexto, token: string, cuerpo: unknown = { profesionales: 2, periodo: 'mensual' }) =>
  pedir(ctx, '/api/v1/pagos/ordenes', { method: 'POST', token, body: cuerpo });

const confirmar = (ctx: Contexto, token: string, referencia: string, cuerpo?: unknown) =>
  pedir(ctx, `/api/v1/pagos/ordenes/${referencia}/confirmar`, { method: 'POST', token, body: cuerpo });

// "Paga" en la página de pruebas del proveedor simulado (aprobar o rechazar) y devuelve a dónde redirige
const pagarSimulado = async (ctx: Contexto, urlPago: string, resultado: 'aprobar' | 'rechazar') => {
  // La URL trae el puerto configurado del servidor (4000); en la prueba se usa el servidor de la prueba
  const r = await fetch(`${ctx.url}${new URL(urlPago).pathname}/${resultado}`, { redirect: 'manual' });
  return { estado: r.status, destino: r.headers.get('location') };
};

const filas = async (ctx: Contexto, sql: string, params: unknown[] = []) => (await ctx.pool.query(sql, params)).rows;
const estadoEmpresa = async (ctx: Contexto, id: string) =>
  (await filas(ctx, 'SELECT estado_suscripcion FROM empresas WHERE id = $1', [id]))[0].estado_suscripcion;

describe('pagos con proveedor simulado', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar({ entorno: { URL_PAGOS, PROVEEDOR_PAGO: 'simulado' } });
  });
  after(() => ctx.cerrar());

  test('crea una orden con el precio de las reglas actuales y la URL de pago simulada', async () => {
    const { token } = await negocioNuevo(ctx);
    const r = await crearOrden(ctx, token, { profesionales: 3, periodo: 'anual' });
    assert.equal(r.estado, 201);
    assert.equal(r.json.monto, precioPara(3, 'anual'));
    assert.equal(r.json.moneda, 'COP');
    assert.equal(r.json.estado, 'pendiente');
    assert.equal(r.json.proveedor, 'simulado');
    assert.match(r.json.referencia, /^AGD-[A-Z0-9]+-[A-F0-9]{12}$/);
    assert.ok(r.json.urlPago.endsWith(`/api/v1/pagos/simulado/${r.json.referencia}`));
    const [fila] = await filas(ctx, 'SELECT monto_centavos, estado FROM ordenes_pago WHERE referencia = $1', [r.json.referencia]);
    assert.equal(Number(fila.monto_centavos), precioPara(3, 'anual') * 100);
    assert.equal(fila.estado, 'pendiente');
  });

  test('cada orden tiene su propia referencia', async () => {
    const { token } = await negocioNuevo(ctx);
    const a = await crearOrden(ctx, token);
    const b = await crearOrden(ctx, token);
    assert.notEqual(a.json.referencia, b.json.referencia);
  });

  test('valida el número de profesionales y el periodo', async () => {
    const { token } = await negocioNuevo(ctx);
    for (const cuerpo of [
      { profesionales: 0, periodo: 'mensual' },
      { profesionales: 11, periodo: 'mensual' },
      { profesionales: 1.5, periodo: 'mensual' },
      { profesionales: '2', periodo: 'mensual' },
      { profesionales: 2, periodo: 'semanal' },
      { periodo: 'mensual' },
    ]) {
      const r = await crearOrden(ctx, token, cuerpo);
      assert.equal(r.estado, 400, JSON.stringify(cuerpo));
    }
  });

  test('solo la administración paga: sin sesión 401 y un empleado 403', async () => {
    assert.equal((await crearOrden(ctx, '')).estado, 401);
    const empleado = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    assert.equal((await crearOrden(ctx, empleado)).estado, 403);
  });

  test('no se puede pagar menos profesionales de los que atienden clientes hoy', async () => {
    const admin = await iniciarSesion(ctx, 'admin.a', '1234');
    const r = await crearOrden(ctx, admin, { profesionales: 1, periodo: 'mensual' });
    assert.equal(r.estado, 409);
    assert.match(r.json.error, /elige al menos 3/);
  });

  test('pago aprobado: activa el plan, anota la actividad y suma al historial de ingresos', async () => {
    const { token, empresaId } = await negocioNuevo(ctx);
    const orden = await crearOrden(ctx, token, { profesionales: 2, periodo: 'mensual' });
    const { estado, destino } = await pagarSimulado(ctx, orden.json.urlPago, 'aprobar');
    assert.equal(estado, 302);
    assert.equal(destino, `${URL_PAGOS}/${orden.json.referencia}?id=sim_${orden.json.referencia}`);

    const r = await confirmar(ctx, token, orden.json.referencia, { idTransaccion: `sim_${orden.json.referencia}` });
    assert.equal(r.estado, 200);
    assert.equal(r.json.estado, 'aprobada');
    assert.equal(r.json.activada, true);

    const [e] = await filas(
      ctx,
      'SELECT estado_suscripcion, plan_suscripcion, plan_equipo, profesionales_pagados, fecha_pago, suscripcion_fin FROM empresas WHERE id = $1',
      [empresaId],
    );
    assert.equal(e.estado_suscripcion, 'activa');
    assert.equal(e.plan_suscripcion, 'mensual');
    assert.equal(e.plan_equipo, 'equipo');
    assert.equal(e.profesionales_pagados, 2);
    assert.ok(e.fecha_pago && e.suscripcion_fin);

    const historial = await filas(ctx, 'SELECT precio, origen, profesionales FROM activaciones_plan WHERE empresa_id = $1', [empresaId]);
    assert.equal(historial.length, 1);
    assert.equal(historial[0].origen, 'pasarela');
    assert.equal(Number(historial[0].precio), precioPara(2, 'mensual'));
    assert.equal(historial[0].profesionales, 2);

    const actividad = await filas(ctx, 'SELECT accion, superadmin_correo, referencia FROM actividad_superadmin WHERE empresa_id = $1', [empresaId]);
    assert.equal(actividad.length, 1);
    assert.equal(actividad[0].accion, 'pago_aprobado');
    assert.equal(actividad[0].superadmin_correo, 'pasarela:simulado');
    assert.equal(actividad[0].referencia, orden.json.referencia);

    // El panel del superadmin ve el ingreso (estimado)
    const superadmin = await crearSuperadmin(ctx);
    const ingresos = await pedir(ctx, '/api/v1/superadmin/ingresos', { token: superadmin });
    assert.ok(ingresos.json.bruto >= precioPara(2, 'mensual'));
  });

  test('una orden nunca se activa dos veces, ni confirmando varias veces a la vez', async () => {
    const { token, empresaId } = await negocioNuevo(ctx);
    const orden = await crearOrden(ctx, token);
    await pagarSimulado(ctx, orden.json.urlPago, 'aprobar');
    const respuestas = await Promise.all(Array.from({ length: 6 }, () => confirmar(ctx, token, orden.json.referencia)));
    for (const r of respuestas) {
      assert.equal(r.estado, 200);
      assert.equal(r.json.estado, 'aprobada');
    }
    assert.equal((await filas(ctx, 'SELECT 1 FROM activaciones_plan WHERE empresa_id = $1', [empresaId])).length, 1);
    assert.equal((await filas(ctx, 'SELECT 1 FROM actividad_superadmin WHERE empresa_id = $1', [empresaId])).length, 1);
    const [{ suscripcion_fin: fin }] = await filas(ctx, 'SELECT suscripcion_fin FROM empresas WHERE id = $1', [empresaId]);
    await confirmar(ctx, token, orden.json.referencia);
    const [{ suscripcion_fin: despues }] = await filas(ctx, 'SELECT suscripcion_fin FROM empresas WHERE id = $1', [empresaId]);
    assert.deepEqual(despues, fin, 'confirmar de nuevo no alarga el plan');
    assert.equal((await filas(ctx, 'SELECT 1 FROM activaciones_plan WHERE empresa_id = $1', [empresaId])).length, 1);
  });

  test('sin pagar, confirmar deja la orden pendiente y no activa nada', async () => {
    const { token, empresaId } = await negocioNuevo(ctx);
    const orden = await crearOrden(ctx, token);
    const r = await confirmar(ctx, token, orden.json.referencia);
    assert.equal(r.estado, 200);
    assert.equal(r.json.estado, 'pendiente');
    assert.equal(await estadoEmpresa(ctx, empresaId), 'trial');
  });

  test('pago rechazado: la orden queda rechazada y el plan no se activa', async () => {
    const { token, empresaId } = await negocioNuevo(ctx);
    const orden = await crearOrden(ctx, token);
    await pagarSimulado(ctx, orden.json.urlPago, 'rechazar');
    const r = await confirmar(ctx, token, orden.json.referencia);
    assert.equal(r.json.estado, 'rechazada');
    assert.equal(r.json.activada, false);
    assert.equal(await estadoEmpresa(ctx, empresaId), 'trial');
    assert.equal((await filas(ctx, 'SELECT 1 FROM activaciones_plan WHERE empresa_id = $1', [empresaId])).length, 0);
    // Una orden ya rechazada no vuelve a pagarse en la página de pruebas
    assert.equal((await pagarSimulado(ctx, orden.json.urlPago, 'aprobar')).estado, 409);
  });

  test('una orden de otro negocio no se ve ni se confirma (404)', async () => {
    const a = await negocioNuevo(ctx);
    const b = await negocioNuevo(ctx);
    const orden = await crearOrden(ctx, a.token);
    assert.equal((await pedir(ctx, `/api/v1/pagos/ordenes/${orden.json.referencia}`, { token: b.token })).estado, 404);
    assert.equal((await confirmar(ctx, b.token, orden.json.referencia)).estado, 404);
  });

  test('la administradora con la suscripción vencida también puede pagar', async () => {
    const { token, empresaId } = await negocioNuevo(ctx);
    await ctx.pool.query("UPDATE empresas SET trial_ends_at = now() - interval '2 days' WHERE id = $1", [empresaId]);
    const orden = await crearOrden(ctx, token);
    assert.equal(orden.estado, 201);
    await pagarSimulado(ctx, orden.json.urlPago, 'aprobar');
    assert.equal((await confirmar(ctx, token, orden.json.referencia)).json.estado, 'aprobada');
  });

  test('un negocio suspendido no puede crear órdenes', async () => {
    const { token, empresaId } = await negocioNuevo(ctx);
    await ctx.pool.query("UPDATE empresas SET suspendida_en = now(), suspension_motivo = 'prueba' WHERE id = $1", [empresaId]);
    assert.equal((await crearOrden(ctx, token)).estado, 403);
  });

  test('el webhook no existe con el proveedor simulado', async () => {
    const r = await pedir(ctx, '/api/v1/pagos/webhook', { method: 'POST', body: { event: 'transaction.updated' } });
    assert.equal(r.estado, 404);
  });
});

describe('pagos: la pasarela debe coincidir con la orden', () => {
  // Proveedor de mentira que responde lo que le pidamos, para probar monto y referencia distintos
  let respuesta: (referencia: string, montoCentavos: number) => ResultadoPago | null;
  let ctx: Contexto;
  const proveedor: ProveedorPago = {
    nombre: 'simulado',
    crearPago: async (o) => ({ url: `https://pasarela.test/${o.referencia}` }),
    consultarPago: async ({ referencia }) => {
      const f = (await ctx.pool.query('SELECT monto_centavos FROM ordenes_pago WHERE referencia = $1', [referencia])).rows[0];
      return respuesta(referencia, Number(f.monto_centavos));
    },
  };
  before(async () => {
    ctx = await iniciar({ entorno: { URL_PAGOS }, proveedorPago: proveedor });
  });
  after(() => ctx.cerrar());

  const aprobado = (referencia: string, montoCentavos: number, cambios: Partial<ResultadoPago> = {}): ResultadoPago => ({
    estado: 'aprobada',
    referencia,
    montoCentavos,
    moneda: 'COP',
    idExterno: `tx_${referencia}`,
    ...cambios,
  });

  const casos: [string, (m: number) => Partial<ResultadoPago>][] = [
    ['el monto es menor', (m) => ({ montoCentavos: m - 100 })],
    ['el monto es mayor', (m) => ({ montoCentavos: m + 100 })],
    ['la referencia es otra', () => ({ referencia: 'AGD-OTRA' })],
    ['la moneda es otra', () => ({ moneda: 'USD' })],
  ];
  for (const [nombre, cambios] of casos) {
    test(`aprobada pero ${nombre}: no se activa el plan`, async () => {
      const { token, empresaId } = await negocioNuevo(ctx);
      const orden = await crearOrden(ctx, token);
      respuesta = (ref, monto) => aprobado(ref, monto, cambios(monto));
      const r = await confirmar(ctx, token, orden.json.referencia);
      assert.equal(r.estado, 409);
      assert.equal(await estadoEmpresa(ctx, empresaId), 'trial');
      assert.equal((await filas(ctx, 'SELECT estado FROM ordenes_pago WHERE referencia = $1', [orden.json.referencia]))[0].estado, 'pendiente');
      assert.equal((await filas(ctx, 'SELECT 1 FROM activaciones_plan WHERE empresa_id = $1', [empresaId])).length, 0);
    });
  }

  test('aprobada y coincidente se activa; pendiente o desconocida en la pasarela, no', async () => {
    const { token, empresaId } = await negocioNuevo(ctx);
    const orden = await crearOrden(ctx, token);
    respuesta = (ref, monto) => aprobado(ref, monto, { estado: 'pendiente' });
    assert.equal((await confirmar(ctx, token, orden.json.referencia)).json.estado, 'pendiente');
    respuesta = () => null;
    assert.equal((await confirmar(ctx, token, orden.json.referencia)).json.estado, 'pendiente');
    assert.equal(await estadoEmpresa(ctx, empresaId), 'trial');
    respuesta = (ref, monto) => aprobado(ref, monto);
    assert.equal((await confirmar(ctx, token, orden.json.referencia)).json.estado, 'aprobada');
    assert.equal(await estadoEmpresa(ctx, empresaId), 'activa');
  });

  test('un rechazo no cierra la orden: si la persona reintenta y paga con la misma referencia, se activa', async () => {
    const { token, empresaId } = await negocioNuevo(ctx);
    const orden = await crearOrden(ctx, token);
    respuesta = (ref, monto) => aprobado(ref, monto, { estado: 'rechazada', idExterno: 'tx_intento_1' });
    assert.equal((await confirmar(ctx, token, orden.json.referencia)).json.estado, 'rechazada');
    assert.equal(await estadoEmpresa(ctx, empresaId), 'trial');
    respuesta = (ref, monto) => aprobado(ref, monto, { idExterno: 'tx_intento_2' });
    const r = await confirmar(ctx, token, orden.json.referencia);
    assert.equal(r.json.estado, 'aprobada');
    assert.equal(r.json.activada, true);
    assert.equal(await estadoEmpresa(ctx, empresaId), 'activa');
    assert.equal((await filas(ctx, 'SELECT 1 FROM activaciones_plan WHERE empresa_id = $1', [empresaId])).length, 1);
    // Una orden aprobada es definitiva: un rechazo o una anulación posteriores no la tocan
    respuesta = (ref, monto) => aprobado(ref, monto, { estado: 'anulada' });
    assert.equal((await confirmar(ctx, token, orden.json.referencia)).json.estado, 'aprobada');
    assert.equal(await estadoEmpresa(ctx, empresaId), 'activa');
  });

  test('un rechazo posterior no cambia una orden anulada ni la activa', async () => {
    const { token, empresaId } = await negocioNuevo(ctx);
    const orden = await crearOrden(ctx, token);
    respuesta = (ref, monto) => aprobado(ref, monto, { estado: 'anulada' });
    assert.equal((await confirmar(ctx, token, orden.json.referencia)).json.estado, 'anulada');
    respuesta = (ref, monto) => aprobado(ref, monto, { estado: 'rechazada' });
    assert.equal((await confirmar(ctx, token, orden.json.referencia)).json.estado, 'anulada');
    assert.equal(await estadoEmpresa(ctx, empresaId), 'trial');
  });

  test('la misma transacción de la pasarela no puede pagar dos órdenes', async () => {
    const { token } = await negocioNuevo(ctx);
    const a = await crearOrden(ctx, token);
    const b = await crearOrden(ctx, token);
    respuesta = (ref, monto) => aprobado(ref, monto, { idExterno: 'tx_repetida' });
    assert.equal((await confirmar(ctx, token, a.json.referencia)).json.estado, 'aprobada');
    const r = await confirmar(ctx, token, b.json.referencia);
    assert.notEqual(r.estado, 200);
    assert.equal((await filas(ctx, 'SELECT estado FROM ordenes_pago WHERE referencia = $1', [b.json.referencia]))[0].estado, 'pendiente');
  });
});

describe('proveedor Wompi (sin llaves reales: llamadas a Wompi simuladas)', () => {
  const llaves = { publica: 'pub_test_abc', privada: 'prv_test_abc', secretoEventos: 'test_events_secreto', secretoIntegridad: 'test_integrity_secreto' };
  const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

  test('la URL de pago lleva la firma de integridad de la documentación (referencia+monto+moneda+secreto)', async () => {
    const wompi = crearProveedorWompi(llaves);
    const { url } = await wompi.crearPago({ referencia: 'AGD-1', montoCentavos: 6_000_000, moneda: 'COP', urlRegreso: `${URL_PAGOS}/AGD-1` });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://checkout.wompi.co/p/');
    assert.equal(u.searchParams.get('public-key'), llaves.publica);
    assert.equal(u.searchParams.get('currency'), 'COP');
    assert.equal(u.searchParams.get('amount-in-cents'), '6000000');
    assert.equal(u.searchParams.get('reference'), 'AGD-1');
    assert.equal(u.searchParams.get('redirect-url'), `${URL_PAGOS}/AGD-1`);
    assert.equal(u.searchParams.get('signature:integrity'), sha256(`AGD-16000000COP${llaves.secretoIntegridad}`));
    assert.ok(!url.includes(llaves.secretoIntegridad) && !url.includes(llaves.privada), 'los secretos nunca van en la URL');
  });

  const evento = (referencia = 'AGD-1', monto = 6_000_000, estado = 'APPROVED') => {
    const t = { id: `tx-${referencia}`, status: estado, amount_in_cents: monto, reference: referencia, currency: 'COP' };
    const timestamp = 1_700_000_000;
    return {
      event: 'transaction.updated',
      data: { transaction: t },
      environment: 'test',
      signature: {
        properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
        checksum: sha256(`${t.id}${t.status}${t.amount_in_cents}${timestamp}${llaves.secretoEventos}`),
      },
      timestamp,
      sent_at: '2026-10-28T10:00:00.000Z',
    };
  };

  test('verifica la firma del evento como indica la documentación y rechaza lo adulterado', async () => {
    const wompi = crearProveedorWompi(llaves);
    assert.deepEqual(await wompi.verificarEvento!(evento()), { referencia: 'AGD-1', idExterno: 'tx-AGD-1' });
    const checksumMalo = evento();
    checksumMalo.signature.checksum = 'a'.repeat(64);
    assert.equal(await wompi.verificarEvento!(checksumMalo), null);
    const adulterado = evento();
    adulterado.data.transaction.amount_in_cents = 100;
    assert.equal(await wompi.verificarEvento!(adulterado), null);
    assert.equal(await crearProveedorWompi({ ...llaves, secretoEventos: 'test_events_otro' }).verificarEvento!(evento()), null);
    assert.equal(await wompi.verificarEvento!({ cualquier: 'cosa' }), null);
  });

  describe('con la app completa', () => {
    const fetchOriginal = globalThis.fetch;
    let ctx: Contexto;
    let estadoWompi = 'APPROVED';
    let montoWompi: number | null = null;
    const consultas: string[] = [];
    before(async () => {
      ctx = await iniciar({ entorno: { URL_PAGOS }, proveedorPago: crearProveedorWompi(llaves) });
      // Solo se intercepta la API de Wompi: las llamadas a nuestro propio servidor pasan tal cual
      globalThis.fetch = (async (entrada: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(entrada instanceof Request ? entrada.url : entrada);
        if (!url.includes('sandbox.wompi.co')) return fetchOriginal(entrada, init);
        consultas.push(url);
        const fila = (await ctx.pool.query('SELECT referencia, monto_centavos FROM ordenes_pago ORDER BY id DESC LIMIT 1')).rows[0];
        const tx = {
          id: `tx-${fila.referencia}`,
          created_at: '2026-10-28T10:00:00.000Z',
          amount_in_cents: montoWompi ?? Number(fila.monto_centavos),
          reference: fila.referencia,
          currency: 'COP',
          payment_method_type: 'CARD',
          status: estadoWompi,
          customer_email: 'x@y.co',
        };
        const cuerpo = url.includes('/transactions?') ? { data: [tx] } : { data: tx };
        return new Response(JSON.stringify(cuerpo), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
    });
    after(async () => {
      globalThis.fetch = fetchOriginal;
      await ctx.cerrar();
    });

    test('la orden devuelve la URL de Wompi y el webhook activa el plan tras volver a consultar a Wompi', async () => {
      const { token, empresaId } = await negocioNuevo(ctx);
      const orden = await crearOrden(ctx, token, { profesionales: 2, periodo: 'mensual' });
      assert.equal(orden.estado, 201);
      assert.equal(orden.json.proveedor, 'wompi');
      assert.ok(orden.json.urlPago.startsWith('https://checkout.wompi.co/p/?'));

      const firmado = evento(orden.json.referencia, orden.json.monto * 100);

      // Firma inválida: 401 y no se activa nada
      const malo = { ...firmado, signature: { ...firmado.signature, checksum: 'f'.repeat(64) } };
      assert.equal((await pedir(ctx, '/api/v1/pagos/webhook', { method: 'POST', body: malo })).estado, 401);
      assert.equal(await estadoEmpresa(ctx, empresaId), 'trial');

      estadoWompi = 'APPROVED';
      montoWompi = null;
      consultas.length = 0;
      const bueno = await pedir(ctx, '/api/v1/pagos/webhook', { method: 'POST', body: firmado });
      assert.equal(bueno.estado, 200);
      assert.ok(consultas.length > 0, 'el estado se vuelve a pedir a Wompi: el evento no basta');
      assert.equal(await estadoEmpresa(ctx, empresaId), 'activa');
      assert.equal((await filas(ctx, 'SELECT origen FROM activaciones_plan WHERE empresa_id = $1', [empresaId]))[0].origen, 'pasarela');

      // El mismo evento otra vez (Wompi reintenta) no activa de nuevo
      assert.equal((await pedir(ctx, '/api/v1/pagos/webhook', { method: 'POST', body: firmado })).estado, 200);
      assert.equal((await filas(ctx, 'SELECT 1 FROM activaciones_plan WHERE empresa_id = $1', [empresaId])).length, 1);
    });

    test('un evento firmado que dice "aprobado" no activa nada si Wompi dice otra cosa o otro monto', async () => {
      const { token, empresaId } = await negocioNuevo(ctx);
      const orden = await crearOrden(ctx, token);

      estadoWompi = 'DECLINED';
      await pedir(ctx, '/api/v1/pagos/webhook', { method: 'POST', body: evento(orden.json.referencia, orden.json.monto * 100) });
      assert.equal((await filas(ctx, 'SELECT estado FROM ordenes_pago WHERE referencia = $1', [orden.json.referencia]))[0].estado, 'rechazada');
      assert.equal(await estadoEmpresa(ctx, empresaId), 'trial');

      const otra = await crearOrden(ctx, token);
      estadoWompi = 'APPROVED';
      montoWompi = 100;
      await pedir(ctx, '/api/v1/pagos/webhook', { method: 'POST', body: evento(otra.json.referencia, otra.json.monto * 100) });
      assert.equal((await filas(ctx, 'SELECT estado FROM ordenes_pago WHERE referencia = $1', [otra.json.referencia]))[0].estado, 'pendiente');
      assert.equal(await estadoEmpresa(ctx, empresaId), 'trial');
      montoWompi = null;
    });

    test('un evento firmado de una referencia que no es nuestra se reconoce y se ignora', async () => {
      const r = await pedir(ctx, '/api/v1/pagos/webhook', { method: 'POST', body: evento('OTRO-COBRO') });
      assert.equal(r.estado, 200);
    });

    test('al volver del pago, confirmar consulta a Wompi con el id de la transacción', async () => {
      const { token } = await negocioNuevo(ctx);
      const orden = await crearOrden(ctx, token);
      estadoWompi = 'APPROVED';
      consultas.length = 0;
      const r = await confirmar(ctx, token, orden.json.referencia, { idTransaccion: `tx-${orden.json.referencia}` });
      assert.equal(r.json.estado, 'aprobada');
      assert.ok(consultas.some((u) => u.endsWith(`/transactions/tx-${orden.json.referencia}`)));
    });
  });
});

describe('pagos desactivados (sin proveedor)', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar({ entorno: { URL_PAGOS }, proveedorPago: 'ausente' });
  });
  after(() => ctx.cerrar());

  test('crear una orden responde 503 y el webhook no existe', async () => {
    const { token } = await negocioNuevo(ctx);
    const r = await crearOrden(ctx, token);
    assert.equal(r.estado, 503);
    assert.equal((await pedir(ctx, '/api/v1/pagos/webhook', { method: 'POST', body: {} })).estado, 404);
  });

  test('el servicio sin URL_PAGOS tampoco crea órdenes (503)', async () => {
    const servicio = crearServicioPagos({
      pool: ctx.pool,
      proveedor: { nombre: 'simulado', crearPago: async () => ({ url: 'x' }), consultarPago: async () => null },
    });
    await assert.rejects(servicio.crearOrden('x', { profesionales: 1, periodo: 'mensual' }), (e: { estado?: number }) => e.estado === 503);
  });
});
