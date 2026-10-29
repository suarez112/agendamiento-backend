import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { crearServicioNotificaciones } from '../src/modules/notificaciones/notificaciones.servicio.js';
import type { Correo } from '../src/shared/correo.js';
import type { EnviadorPush } from '../src/shared/push.js';
import { type Contexto, iniciar, registrarEmpresa } from './apoyo/servidor.js';

const URL_PAGOS = 'https://pagos.ejemplo.co/pagar';

// Correos y avisos de la prueba gratuita: día 10, día 14 y al vencer
describe('avisos de la prueba gratuita', () => {
  let ctx: Contexto;
  let pool: pg.Pool;
  before(async () => {
    ctx = await iniciar();
    pool = ctx.pool;
  });
  after(() => ctx.cerrar());

  const pushVacio: EnviadorPush = { enviar: async (mensajes) => mensajes.map((m) => ({ token: m.to, ok: true, tokenInvalido: false })) };

  const armar = (urlPagos?: string) => {
    const correos: Correo[] = [];
    const servicio = crearServicioNotificaciones({
      pool,
      push: pushVacio,
      correo: { enviar: async (c) => void correos.push(c) },
      urlPagos,
    });
    return { servicio, correos };
  };

  let n = 0;
  // Negocio nuevo con su administradora; la prueba se acomoda a los días indicados
  const negocio = async (diasDesdeRegistro: number, diasParaFinDePrueba: number, estado = 'trial') => {
    const correo = `admin.prueba${++n}@central.co`;
    const r = await registrarEmpresa(ctx, { correo });
    assert.equal(r.estado, 201, r.texto);
    await pool.query(
      `UPDATE empresas SET created_at = now() - make_interval(days => $2), trial_ends_at = now() + make_interval(days => $3), estado_suscripcion = $4
       WHERE id = $1`,
      [r.json.empresa.id, diasDesdeRegistro, diasParaFinDePrueba, estado],
    );
    return { id: r.json.empresa.id as string, usuarioId: r.json.usuario.id as string, correo };
  };

  const notificacionesDe = async (usuarioId: string) =>
    (await pool.query<{ texto: string; titulo: string }>(`SELECT titulo, texto FROM notificaciones WHERE usuario_id = $1 AND tipo = 'prueba_resumen'`, [usuarioId])).rows;

  test('día 10: el correo lleva el enlace de pago y la notificación de la app no lleva enlaces', async () => {
    const e = await negocio(10, 5);
    const { servicio, correos } = armar(URL_PAGOS);
    await servicio.enviarAvisosPrueba();

    const suyos = correos.filter((c) => c.para === e.correo);
    assert.equal(suyos.length, 1);
    assert.match(suyos[0].texto, new RegExp(`Activa tu plan aquí: ${URL_PAGOS}`));
    assert.match(suyos[0].asunto, /Vas muy bien en tu prueba gratuita/);

    const enApp = await notificacionesDe(e.usuarioId);
    assert.equal(enApp.length, 1);
    assert.doesNotMatch(`${enApp[0].titulo} ${enApp[0].texto}`, /https?:|URL|pagos\.ejemplo/);
    assert.match(enApp[0].texto, /activa un plan/i);
  });

  test('cada aviso se envía una sola vez', async () => {
    const e = await negocio(11, 4);
    const { servicio, correos } = armar(URL_PAGOS);
    await servicio.enviarAvisosPrueba();
    await servicio.enviarAvisosPrueba();
    assert.equal(correos.filter((c) => c.para === e.correo).length, 1);
    assert.equal((await notificacionesDe(e.usuarioId)).length, 1);
  });

  test('día 14: correo con el enlace y notificación sin enlaces', async () => {
    const e = await negocio(14, 1);
    const { servicio, correos } = armar(URL_PAGOS);
    await servicio.enviarAvisosPrueba();
    const suyos = correos.filter((c) => c.para === e.correo);
    assert.equal(suyos.length, 1);
    assert.match(suyos[0].asunto, /termina pronto/);
    assert.ok(suyos[0].texto.includes(URL_PAGOS));
    assert.doesNotMatch((await notificacionesDe(e.usuarioId))[0].texto, /https?:/);
  });

  test('al vencer: un aviso con el enlace; si venció hace más de 3 días ya no se envía', async () => {
    const reciente = await negocio(16, -1);
    const vieja = await negocio(30, -10);
    const { servicio, correos } = armar(URL_PAGOS);
    await servicio.enviarAvisosPrueba();

    const suyos = correos.filter((c) => c.para === reciente.correo);
    assert.equal(suyos.length, 1);
    assert.match(suyos[0].asunto, /terminó/);
    assert.ok(suyos[0].texto.includes(URL_PAGOS));
    assert.match((await notificacionesDe(reciente.usuarioId))[0].texto, /Tu prueba gratuita terminó/);

    assert.equal(correos.filter((c) => c.para === vieja.correo).length, 0);
    assert.equal((await notificacionesDe(vieja.usuarioId)).length, 0);
  });

  test('un negocio que ya pagó un plan, o suspendido, no recibe avisos', async () => {
    const activo = await negocio(12, 3, 'activa');
    const suspendido = await negocio(12, 3);
    await pool.query(`UPDATE empresas SET suspendida_en = now(), suspension_motivo = 'prueba' WHERE id = $1`, [suspendido.id]);
    const { servicio, correos } = armar(URL_PAGOS);
    await servicio.enviarAvisosPrueba();
    assert.equal(correos.filter((c) => c.para === activo.correo || c.para === suspendido.correo).length, 0);
  });

  test('sin URL_PAGOS el correo sale sin enlace, y sin enviador de correo solo queda la notificación', async () => {
    const e = await negocio(10, 5);
    const sinUrl = armar();
    await sinUrl.servicio.enviarAvisosPrueba();
    const suyos = sinUrl.correos.filter((c) => c.para === e.correo);
    assert.equal(suyos.length, 1);
    assert.doesNotMatch(suyos[0].texto, /https?:|Activa tu plan aquí/);

    const f = await negocio(10, 5);
    const servicio = crearServicioNotificaciones({ pool, push: pushVacio });
    assert.ok((await servicio.enviarAvisosPrueba()) >= 1);
    assert.equal((await notificacionesDe(f.usuarioId)).length, 1);
  });

  test('un fallo al enviar el correo no impide la notificación de la app', async () => {
    const e = await negocio(10, 5);
    const servicio = crearServicioNotificaciones({
      pool,
      push: pushVacio,
      correo: { enviar: async () => Promise.reject(new Error('sin servicio de correo')) },
      urlPagos: URL_PAGOS,
    });
    await servicio.enviarAvisosPrueba();
    assert.equal((await notificacionesDe(e.usuarioId)).length, 1);
  });

  test('en desarrollo el correo se imprime en la consola con el enlace', async () => {
    const { crearEnviadorCorreo } = await import('../src/shared/correo.js');
    const lineas: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => void lineas.push(a.join(' '));
    try {
      await crearEnviadorCorreo('development').enviar({ para: 'a@b.co', asunto: 'Asunto', texto: `Activa tu plan aquí: ${URL_PAGOS}` });
    } finally {
      console.log = original;
    }
    assert.ok(lineas.join('\n').includes(URL_PAGOS));
  });
});
