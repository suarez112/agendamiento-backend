import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { crearServicioNotificaciones } from '../src/modules/notificaciones/notificaciones.servicio.js';
import { DIAS_VIGENCIA_TOKEN_PUSH } from '../src/modules/notificaciones/notificaciones.repositorio.js';
import { iniciarRecordatorios } from '../src/modules/notificaciones/recordatorios.js';
import type { EnviadorPush, MensajePush } from '../src/shared/push.js';
import { fechaEnDias } from './apoyo/baseDePrueba.js';
import { type Contexto, esperarHasta, iniciar, iniciarSesion, pedir, reservaValida } from './apoyo/servidor.js';

// Enviador falso: guarda lo que se enviaría a Expo
const crearEnviadorEspia = () => {
  const enviados: MensajePush[] = [];
  const enviador: EnviadorPush = {
    async enviar(mensajes) {
      enviados.push(...mensajes);
      return mensajes.map((m) => ({ token: m.to, ok: true, tokenInvalido: false }));
    },
  };
  return { enviador, enviados };
};

// B-5 — la push no lleva el nombre del cliente, y los celulares que no se usan vencen
describe('notificaciones push', () => {
  let ctx: Contexto;
  let pool: pg.Pool;
  before(async () => {
    ctx = await iniciar();
    pool = ctx.pool;
  });
  after(() => ctx.cerrar());

  const registrarCelular = (token: string, celular: string) =>
    pedir(ctx, '/api/v1/dispositivos', { method: 'PUT', token, body: { token: celular } });

  test('los avisos de cita (nueva, cancelada y reprogramada por el cliente) no llevan el nombre del cliente', async () => {
    const { enviador, enviados } = crearEnviadorEspia();
    const servicio = crearServicioNotificaciones({ pool, push: enviador });
    const admin = await iniciarSesion(ctx, 'admin.a', '1234');
    assert.equal((await registrarCelular(admin, 'ExponentPushToken[admin_a_celular]')).estado, 200);

    const cita = await pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      body: reservaValida({ fecha: fechaEnDias(3), nombre: 'Nombre Secreto Del Cliente', telefono: '3100000601' }),
    });
    assert.equal(cita.estado, 201, cita.texto);
    const citaId = cita.json.cita.id as string;

    await servicio.avisarCitaNueva(citaId);
    await servicio.avisarCancelacionPorCliente(citaId);
    await servicio.avisarReprogramacion(citaId, { fecha: '01/01/2030', hora: '10:00 AM' });

    assert.equal(enviados.length, 3);
    for (const m of enviados) {
      assert.ok(!JSON.stringify(m).includes('Nombre Secreto'), JSON.stringify(m));
      assert.match(m.body, /Corte/, 'el aviso sigue diciendo qué servicio es');
      assert.equal((m.data as { citaId: string }).citaId, citaId, 'la app puede abrir la cita');
    }
    assert.equal(enviados[0].body, `Nueva reserva de Corte para el ${enviados[0].body.match(/\d\d\/\d\d\/\d{4}/)![0]} a las 10:00 AM.`);
    // La notificación guardada en la app tampoco lleva el nombre
    const guardadas = await pool.query('SELECT texto FROM notificaciones WHERE cita_id = $1', [citaId]);
    assert.ok(guardadas.rows.length >= 3);
    for (const { texto } of guardadas.rows) assert.ok(!texto.includes('Nombre Secreto'), texto);
  });

  test('la reserva real también guarda la notificación sin el nombre', async () => {
    const cita = await pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      body: reservaValida({ fecha: fechaEnDias(4), nombre: 'Otro Nombre Privado', telefono: '3100000602' }),
    });
    assert.equal(cita.estado, 201, cita.texto);
    const filas = await esperarHasta(async () => {
      const r = await pool.query('SELECT texto FROM notificaciones WHERE cita_id = $1', [cita.json.cita.id]);
      return r.rows.length > 0 && r.rows;
    });
    for (const { texto } of filas) assert.ok(!texto.includes('Otro Nombre Privado'), texto);
  });

  test('un celular que no se registra en 60 días deja de recibir avisos y se borra', async () => {
    assert.equal(DIAS_VIGENCIA_TOKEN_PUSH, 60);
    const admin = await iniciarSesion(ctx, 'admin.b', 'clave-b');
    assert.equal((await registrarCelular(admin, 'ExponentPushToken[celular_nuevo]')).estado, 200);
    assert.equal((await registrarCelular(admin, 'ExponentPushToken[celular_viejo]')).estado, 200);
    await pool.query("UPDATE dispositivos_push SET actualizado_en = now() - interval '61 days' WHERE token = 'ExponentPushToken[celular_viejo]'");

    const { enviador, enviados } = crearEnviadorEspia();
    const servicio = crearServicioNotificaciones({ pool, push: enviador });
    // Una cita en el negocio B para que avise a su administrador
    const cita = await pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      body: reservaValida({ empresaId: 'emp_b', barberoId: 'admin_b', servicioId: 'serv_b', fecha: fechaEnDias(5), telefono: '3100000603' }),
    });
    assert.equal(cita.estado, 201, cita.texto);
    await servicio.avisarCitaNueva(cita.json.cita.id);
    assert.deepEqual(enviados.map((m) => m.to), ['ExponentPushToken[celular_nuevo]'], 'el viejo ya no recibe avisos');

    // Volver a registrarlo (la app lo hace al iniciar sesión) lo mantiene vigente
    assert.equal((await registrarCelular(admin, 'ExponentPushToken[celular_viejo]')).estado, 200);
    enviados.length = 0;
    await servicio.avisarCitaNueva(cita.json.cita.id);
    assert.deepEqual(enviados.map((m) => m.to).sort(), ['ExponentPushToken[celular_nuevo]', 'ExponentPushToken[celular_viejo]']);
  });

  test('la tarea programada borra los celulares vencidos y deja los vigentes', async () => {
    await pool.query("INSERT INTO dispositivos_push (token, barbero_id, actualizado_en) VALUES ('ExponentPushToken[abandonado]', 'admin_a', now() - interval '90 days')");
    await pool.query("INSERT INTO dispositivos_push (token, barbero_id, actualizado_en) VALUES ('ExponentPushToken[reciente]', 'admin_a', now() - interval '59 days')");
    const servicio = crearServicioNotificaciones({ pool, push: crearEnviadorEspia().enviador });
    const detener = iniciarRecordatorios(servicio, 3_600_000);
    try {
      await esperarHasta(async () => (await pool.query("SELECT 1 FROM dispositivos_push WHERE token = 'ExponentPushToken[abandonado]'")).rowCount === 0);
    } finally {
      detener();
    }
    const quedan = await pool.query("SELECT token FROM dispositivos_push WHERE token IN ('ExponentPushToken[abandonado]', 'ExponentPushToken[reciente]')");
    assert.deepEqual(quedan.rows, [{ token: 'ExponentPushToken[reciente]' }]);
  });
});
