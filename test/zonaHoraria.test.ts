import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  aIsoEnZona,
  esZonaValida,
  hoyEn,
  instanteDePared,
  minutosAhoraEn,
  sumarDiasAFecha,
  zonaCanonica,
} from '../src/shared/zonaHoraria.js';
import { type Contexto, iniciar, pedir, registrarCliente, registrarEmpresa, CLAVE_CLIENTE } from './apoyo/servidor.js';

const AUCKLAND = 'Pacific/Auckland';
const BOGOTA = 'America/Bogota';

// Funciones puras, con instantes fijos
describe('zona horaria (cálculo)', () => {
  const instante = '2026-10-22T14:30:00.000Z';

  test('escribe los instantes en ISO 8601 con el desfase de cada zona', () => {
    assert.equal(aIsoEnZona(instante, BOGOTA), '2026-10-22T09:30:00.000-05:00');
    assert.equal(aIsoEnZona(instante, 'Asia/Tokyo'), '2026-10-22T23:30:00.000+09:00');
    assert.equal(aIsoEnZona(instante, AUCKLAND), '2026-10-23T03:30:00.000+13:00');
    assert.equal(aIsoEnZona(instante, 'Asia/Kolkata'), '2026-10-22T20:00:00.000+05:30');
    assert.equal(aIsoEnZona(new Date(instante), BOGOTA), '2026-10-22T09:30:00.000-05:00');
  });

  test('el desfase cambia con el horario de verano', () => {
    assert.equal(aIsoEnZona('2026-07-01T14:30:00.000Z', 'America/New_York'), '2026-07-01T10:30:00.000-04:00');
    assert.equal(aIsoEnZona('2026-12-22T14:30:00.000Z', 'America/New_York'), '2026-12-22T09:30:00.000-05:00');
    assert.equal(aIsoEnZona('2026-12-22T14:30:00.000Z', BOGOTA), '2026-12-22T09:30:00.000-05:00', 'Colombia no cambia de hora');
  });

  test('los instantes vacíos o inválidos dan null en lugar de fallar', () => {
    assert.equal(aIsoEnZona(null, BOGOTA), null);
    assert.equal(aIsoEnZona(undefined, BOGOTA), null);
    assert.equal(aIsoEnZona('no-es-una-fecha', BOGOTA), null);
  });

  test('"hoy" depende de la zona: a las 22:00 en Bogotá ya es el día siguiente en Asia y Oceanía', () => {
    const ahora = new Date('2026-10-23T03:00:00Z');
    assert.equal(hoyEn(BOGOTA, ahora), '2026-10-22');
    assert.equal(hoyEn('America/Mexico_City', ahora), '2026-10-22');
    assert.equal(hoyEn('Asia/Tokyo', ahora), '2026-10-23');
    assert.equal(hoyEn(AUCKLAND, ahora), '2026-10-23');
    assert.equal(hoyEn('Pacific/Honolulu', ahora), '2026-10-22');
  });

  test('los minutos desde la medianoche se cuentan en la zona', () => {
    const ahora = new Date('2026-10-23T03:00:00Z');
    assert.equal(minutosAhoraEn(BOGOTA, ahora), 22 * 60);
    assert.equal(minutosAhoraEn('Asia/Kolkata', ahora), 8 * 60 + 30);
    assert.equal(minutosAhoraEn(AUCKLAND, ahora), 16 * 60);
  });

  test('suma días a una fecha de calendario (meses, años y bisiestos)', () => {
    assert.equal(sumarDiasAFecha('2026-10-22', 14), '2026-11-05');
    assert.equal(sumarDiasAFecha('2026-12-31', 1), '2027-01-01');
    assert.equal(sumarDiasAFecha('2028-02-28', 1), '2028-02-29');
    assert.equal(sumarDiasAFecha('2027-02-28', 1), '2027-03-01');
    assert.equal(sumarDiasAFecha('2026-03-01', -1), '2026-02-28');
    assert.equal(sumarDiasAFecha('2026-10-22', 0), '2026-10-22');
  });

  test('convierte una fecha y hora de pared del negocio en el instante real', () => {
    assert.equal(instanteDePared('2026-10-22', '09:30', BOGOTA).toISOString(), '2026-10-22T14:30:00.000Z');
    assert.equal(instanteDePared('2026-10-23', '03:30', AUCKLAND).toISOString(), '2026-10-22T14:30:00.000Z');
    assert.equal(instanteDePared('2026-07-01', '09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
    assert.equal(instanteDePared('2026-12-01', '09:00', 'America/New_York').toISOString(), '2026-12-01T14:00:00.000Z');
    // Días en que cambia la hora
    assert.equal(instanteDePared('2026-03-08', '12:00', 'America/New_York').toISOString(), '2026-03-08T16:00:00.000Z');
    assert.equal(instanteDePared('2026-11-01', '12:00', 'America/New_York').toISOString(), '2026-11-01T17:00:00.000Z');
  });

  test('valida y normaliza los nombres de zona', () => {
    assert.equal(esZonaValida('America/Bogota'), true);
    assert.equal(esZonaValida('america/bogota'), true);
    for (const mala of ['Marte/Olympus', '', 'x'.repeat(65), 123, null, undefined]) assert.equal(esZonaValida(mala), false, String(mala));
    assert.equal(zonaCanonica('america/bogota'), 'America/Bogota');
    assert.equal(zonaCanonica('asia/tokyo'), 'Asia/Tokyo');
  });
});

// Un negocio en Nueva Zelanda (13 horas adelante de Bogotá en octubre) frente a uno en Bogotá
describe('zona horaria del negocio (API)', () => {
  let ctx: Contexto;
  type Negocio = { token: string; id: string; barberoId: string; servicioId: string };
  let auckland: Negocio;
  let bogota: Negocio;

  const abiertoTodosLosDias = [0, 1, 2, 3, 4, 5, 6].map((dia) => ({ dia, abierto: true, apertura: '08:00', cierre: '19:00' }));
  const crearNegocio = async (n: number, cambios: Record<string, unknown>): Promise<Negocio> => {
    const r = await registrarEmpresa(ctx, { correo: `zona${n}@central.co`, horario: abiertoTodosLosDias, ...cambios });
    assert.equal(r.estado, 201, r.texto);
    const token = r.json.token;
    const servicio = await pedir(ctx, '/api/v1/servicios', { method: 'POST', token, body: { nombre: 'Corte', duracionMin: 30, precio: 20000 } });
    const profesional = await pedir(ctx, '/api/v1/equipo', {
      method: 'POST',
      token,
      body: { nombre: 'Profesional', usuario: `profesional.zona${n}`, clave: 'Clave-segura-1' },
    });
    assert.deepEqual([servicio.estado, profesional.estado], [201, 201]);
    return { token, id: r.json.empresa.id, barberoId: profesional.json.id, servicioId: servicio.json.id };
  };
  const reservar = (negocio: Negocio, fecha: string, hora = '10:00 AM', telefono = '3100000001') =>
    pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      body: {
        empresaId: negocio.id,
        barberoId: negocio.barberoId,
        servicioId: negocio.servicioId,
        fecha,
        hora,
        nombre: 'Cliente Zona',
        telefono,
        aceptaPoliticaDatos: true,
        aceptaTerminos: true,
      },
    });
  const diasEntre = (desde: string, hasta: string) => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);

  before(async () => {
    ctx = await iniciar();
    auckland = await crearNegocio(1, { pais: 'NZ', departamento: 'Auckland', ciudad: 'Auckland', zonaHoraria: AUCKLAND });
    bogota = await crearNegocio(2, {});
  });
  after(() => ctx.cerrar());

  test('el negocio guarda su zona y los instantes salen con el desfase de esa zona', async () => {
    const perfil = await pedir(ctx, '/api/v1/admin/empresa/suscripcion', { token: auckland.token });
    assert.equal(perfil.json.zonaHoraria, AUCKLAND);
    const prueba = await pedir(ctx, '/api/v1/admin/empresa/prueba', { token: auckland.token });
    assert.match(prueba.json.trialEndsAt, /[+]1[23]:00$/, 'Nueva Zelanda: +13:00 en verano o +12:00 en invierno');
    const enBogota = await pedir(ctx, '/api/v1/admin/empresa/prueba', { token: bogota.token });
    assert.match(enBogota.json.trialEndsAt, /-05:00$/);
    // Es el mismo instante que guarda la base, escrito con otro desfase
    const { rows } = await ctx.pool.query('SELECT trial_ends_at FROM empresas WHERE id = $1', [auckland.id]);
    assert.equal(new Date(prueba.json.trialEndsAt).getTime(), rows[0].trial_ends_at.getTime());
  });

  test('"hoy" y el límite de 14 días de las reservas se cuentan en la zona de cada negocio', async () => {
    for (const [nombre, negocio, zona] of [
      ['Nueva Zelanda', auckland, AUCKLAND],
      ['Bogotá', bogota, BOGOTA],
    ] as const) {
      const hoy = hoyEn(zona);
      const ultimo = sumarDiasAFecha(hoy, 14);
      const ok = await reservar(negocio, ultimo, '10:00 AM', '3100000002');
      assert.equal(ok.estado, 201, `${nombre}: el día 14 sí se puede reservar. ${ok.texto}`);

      const lejos = await reservar(negocio, sumarDiasAFecha(hoy, 15));
      assert.equal(lejos.estado, 400, nombre);
      assert.equal(lejos.json.error, `Solo puedes reservar desde hoy hasta 14 días después (hasta el ${ultimo}).`);

      const ayer = await reservar(negocio, sumarDiasAFecha(hoy, -1));
      assert.equal(ayer.estado, 400, nombre);
      assert.deepEqual(ayer.json, { error: 'No se pueden agendar citas en fechas pasadas' });
    }
  });

  test('la cita guarda fecha y hora del negocio y su instante real depende de la zona', async () => {
    const fecha = sumarDiasAFecha(hoyEn(AUCKLAND), 3);
    const r = await reservar(auckland, fecha, '10:00 AM', '3100000003');
    assert.equal(r.estado, 201, r.texto);
    assert.equal(r.json.cita.zonaHoraria, AUCKLAND);
    const { rows } = await ctx.pool.query(
      `SELECT c.fecha::text AS fecha, c.hora_inicio::text AS hora, ((c.fecha + c.hora_inicio) AT TIME ZONE e.zona_horaria) AS instante
       FROM citas c JOIN empresas e ON e.id = c.empresa_id WHERE c.id = $1`,
      [r.json.cita.id],
    );
    assert.deepEqual([rows[0].fecha, rows[0].hora], [fecha, '10:00:00']);
    assert.equal(rows[0].instante.toISOString(), instanteDePared(fecha, '10:00', AUCKLAND).toISOString());

    // Completarla devuelve el momento con el desfase del negocio y es el mismo instante que la base
    const completar = await pedir(ctx, `/api/v1/citas/${r.json.cita.id}/completar`, { method: 'PATCH', token: auckland.token });
    assert.equal(completar.estado, 200, completar.texto);
    assert.match(completar.json.completadaEn, /[+]1[23]:00$/);
    const guardada = await ctx.pool.query('SELECT completada_en FROM citas WHERE id = $1', [r.json.cita.id]);
    assert.equal(new Date(completar.json.completadaEn).getTime(), guardada.rows[0].completada_en.getTime());
  });

  test('los días de prueba son días de calendario de cada zona, aunque sea el mismo instante', async () => {
    // El mismo instante (dentro de 36 horas) cae en días distintos en Nueva Zelanda y en Bogotá
    const fin = new Date(Date.now() + 36 * 3_600_000);
    await ctx.pool.query('UPDATE empresas SET trial_ends_at = $2 WHERE id = ANY($1)', [[auckland.id, bogota.id], fin]);
    for (const [negocio, zona] of [
      [auckland, AUCKLAND],
      [bogota, BOGOTA],
    ] as const) {
      const esperado = diasEntre(hoyEn(zona), hoyEn(zona, fin));
      const r = await pedir(ctx, '/api/v1/admin/empresa/prueba', { token: negocio.token });
      assert.equal(r.json.diasRestantes, esperado, zona);
      assert.equal((await pedir(ctx, '/api/v1/admin/empresa/suscripcion', { token: negocio.token })).json.diasRestantes, esperado, zona);
    }
  });

  test('la prueba termina el día del fin en la zona del negocio: antes de ese día está vigente y ese día ya no', async () => {
    for (const [negocio, zona] of [
      [auckland, AUCKLAND],
      [bogota, BOGOTA],
    ] as const) {
      // Fin mañana a mediodía de la zona: vigente. Fin hoy a mediodía de la zona: vencida (402), aunque falten horas.
      const manana = instanteDePared(sumarDiasAFecha(hoyEn(zona), 1), '12:00', zona);
      const hoy = instanteDePared(hoyEn(zona), '12:00', zona);
      await ctx.pool.query('UPDATE empresas SET trial_ends_at = $2 WHERE id = $1', [negocio.id, manana]);
      assert.equal((await pedir(ctx, '/api/v1/servicios', { token: negocio.token })).estado, 200, `${zona} mañana`);
      await ctx.pool.query('UPDATE empresas SET trial_ends_at = $2 WHERE id = $1', [negocio.id, hoy]);
      assert.equal((await pedir(ctx, '/api/v1/servicios', { token: negocio.token })).estado, 402, `${zona} hoy`);
    }
    // Vuelven a prueba vigente para las demás pruebas
    await ctx.pool.query("UPDATE empresas SET trial_ends_at = now() + interval '10 days' WHERE id = ANY($1)", [[auckland.id, bogota.id]]);
  });

  test('cambiar la zona con citas pendientes se rechaza; sin ellas se permite y las horas siguen siendo las del negocio', async () => {
    const conCitas = await pedir(ctx, '/api/v1/admin/empresa', { method: 'PATCH', token: auckland.token, body: { zonaHoraria: BOGOTA } });
    assert.equal(conCitas.estado, 409);
    assert.match(conCitas.json.error, /^Tienes \d+ cita\(s\) pendiente\(s\)\. Cancélalas o espera a que pasen antes de cambiar la zona horaria/);
    const { rows } = await ctx.pool.query('SELECT zona_horaria FROM empresas WHERE id = $1', [auckland.id]);
    assert.equal(rows[0].zona_horaria, AUCKLAND, 'no cambió');

    const nuevo = await registrarEmpresa(ctx, { correo: 'zona3@central.co' });
    const cambiar = await pedir(ctx, '/api/v1/admin/empresa', { method: 'PATCH', token: nuevo.json.token, body: { zonaHoraria: 'america/lima' } });
    assert.equal(cambiar.estado, 200, cambiar.texto);
    assert.equal(cambiar.json.zonaHoraria, 'America/Lima', 'se guarda con el nombre oficial');
    const invalida = await pedir(ctx, '/api/v1/admin/empresa', { method: 'PATCH', token: nuevo.json.token, body: { zonaHoraria: 'Marte/Olympus' } });
    assert.equal(invalida.estado, 400);
    assert.deepEqual(invalida.json, { error: 'La zona horaria no es válida. Usa un nombre como America/Bogota' });
  });

  test('un cliente solo puede cancelar con la anticipación mínima, medida en la hora del negocio', async () => {
    const cliente = await registrarCliente(ctx, 'zona@correo.com', CLAVE_CLIENTE);
    assert.equal(cliente.estado, 201);
    const usuarioId = cliente.json.usuario.id;
    const clienteId = `cli_zona`;
    await ctx.pool.query(
      "INSERT INTO clientes (id, empresa_id, telefono, indicativo, nombre, total_citas) VALUES ($1, $2, '+573100000077', '57', 'Cliente Zona', 2)",
      [clienteId, auckland.id],
    );
    // Dos citas del negocio de Nueva Zelanda: una empieza dentro de 2 horas y otra dentro de 6 (hora de pared del negocio)
    const insertar = async (id: string, horas: number) => {
      await ctx.pool.query(
        `INSERT INTO citas (id, empresa_id, barbero_id, servicio_id, cliente_id, fecha, hora_inicio, hora_fin, precio, estado, usuario_id)
         SELECT $1, e.id, $3, $4, $5, w.f, LEAST(w.h, time '23:58'),
                CASE WHEN w.h < time '23:30' THEN w.h + interval '30 minutes' ELSE time '23:59' END, 20000, 'CONFIRMADA', $6
         FROM empresas e
         CROSS JOIN LATERAL (SELECT ((now() + make_interval(hours => $7::int)) AT TIME ZONE e.zona_horaria)::date AS f,
                                    ((now() + make_interval(hours => $7::int)) AT TIME ZONE e.zona_horaria)::time AS h) w
         WHERE e.id = $2`,
        [id, auckland.id, auckland.barberoId, auckland.servicioId, clienteId, usuarioId, horas],
      );
    };
    await insertar('cita_cerca', 2);
    await insertar('cita_lejos', 6);
    const token = cliente.json.token;

    const cerca = await pedir(ctx, '/api/v1/mi-cuenta/citas/cita_cerca/cancelar', { method: 'PATCH', token });
    assert.equal(cerca.estado, 409, cerca.texto);
    assert.equal(cerca.json.error, 'Solo puedes cancelar con al menos 3 horas de anticipación. Esta cita empieza dentro de menos tiempo: comunícate con el negocio.');
    const lejos = await pedir(ctx, '/api/v1/mi-cuenta/citas/cita_lejos/cancelar', { method: 'PATCH', token });
    assert.equal(lejos.estado, 200, lejos.texto);
    assert.match(lejos.json.canceladaEn, /[+]1[23]:00$/);
    const { rows } = await ctx.pool.query("SELECT id, estado FROM citas WHERE id IN ('cita_cerca', 'cita_lejos') ORDER BY id");
    assert.deepEqual(rows, [{ id: 'cita_cerca', estado: 'CONFIRMADA' }, { id: 'cita_lejos', estado: 'CANCELADA' }]);
  });
});
