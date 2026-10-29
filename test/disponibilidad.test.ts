import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { calcularHoras, huecosLibres } from '../src/modules/citas/disponibilidad.js';
import { minutosAhoraEn, ZONA_POR_DEFECTO } from '../src/shared/zonaHoraria.js';
import { FECHA_FUTURA, fechaEnDias } from './apoyo/baseDePrueba.js';
import { type Contexto, iniciar, iniciarSesion, pedir, reservaValida } from './apoyo/servidor.js';

const hm = (h: number, m = 0) => h * 60 + m;
const inicios = (horas: { inicio: number }[]) => horas.map((h) => h.inicio);

describe('huecos libres del horario', () => {
  test('quita las citas y los bloqueos del horario del negocio', () => {
    assert.deepEqual(huecosLibres(hm(8), hm(18), [{ inicio: hm(12), fin: hm(13) }]), [
      { inicio: hm(8), fin: hm(12) },
      { inicio: hm(13), fin: hm(18) },
    ]);
  });

  test('junta tramos que se cruzan y ordena los que llegan desordenados', () => {
    assert.deepEqual(
      huecosLibres(hm(8), hm(13), [
        { inicio: hm(10, 30), fin: hm(12) },
        { inicio: hm(10), fin: hm(11) },
      ]),
      [
        { inicio: hm(8), fin: hm(10) },
        { inicio: hm(12), fin: hm(13) },
      ],
    );
  });

  test('un tramo que cubre todo el horario, o que está fuera de él, no deja huecos falsos', () => {
    assert.deepEqual(huecosLibres(hm(8), hm(12), [{ inicio: hm(7), fin: hm(13) }]), []);
    assert.deepEqual(huecosLibres(hm(8), hm(12), [{ inicio: hm(14), fin: hm(15) }]), [{ inicio: hm(8), fin: hm(12) }]);
    assert.deepEqual(huecosLibres(hm(8), hm(12), []), [{ inicio: hm(8), fin: hm(12) }]);
  });
});

describe('horas disponibles (cálculo)', () => {
  test('ejemplo documentado: 08:00 a 12:00 con una cita de 09:10 a 09:50 y un servicio de 30 minutos', () => {
    const horas = calcularHoras({
      apertura: hm(8),
      cierre: hm(12),
      ocupados: [{ inicio: hm(9, 10), fin: hm(9, 50) }],
      duracion: 30,
      intervalo: 30,
      servicioMasCorto: 20,
    });
    // 08:00* 08:40* 09:50* 10:30 11:00 11:30*  (* = pegada); 08:30 y 10:00 dejarían un hueco de 10 min que no se puede vender
    assert.deepEqual(horas, [
      { inicio: hm(8), pegada: true },
      { inicio: hm(8, 40), pegada: true },
      { inicio: hm(9, 50), pegada: true },
      { inicio: hm(10, 30), pegada: false },
      { inicio: hm(11), pegada: false },
      { inicio: hm(11, 30), pegada: true },
    ]);
  });

  test('panel (ocultarHuecosCortos: false): mismo ejemplo, pero también las horas que dejan un hueco corto, con las pegadas marcadas', () => {
    const entrada = {
      apertura: hm(8),
      cierre: hm(12),
      ocupados: [{ inicio: hm(9, 10), fin: hm(9, 50) }],
      duracion: 30,
      intervalo: 30,
      servicioMasCorto: 20,
    };
    const delCliente = calcularHoras(entrada);
    const delPanel = calcularHoras({ ...entrada, ocultarHuecosCortos: false });
    // Se suman 08:30 y 10:00 (dejan 10 min libres); las demás, y su marca de pegada, no cambian
    assert.deepEqual(
      delPanel.map((h) => h.inicio),
      [hm(8), hm(8, 30), hm(8, 40), hm(9, 50), hm(10), hm(10, 30), hm(11), hm(11, 30)],
    );
    for (const h of delCliente) assert.deepEqual(delPanel.find((p) => p.inicio === h.inicio), h);
    assert.equal(delPanel.find((h) => h.inicio === hm(8, 30))?.pegada, false);
    assert.equal(delPanel.find((h) => h.inicio === hm(8, 40))?.pegada, true);
  });

  test('el almuerzo (bloqueo de 12:00 a 13:00) no deja ofrecer ninguna hora que lo toque', () => {
    for (const duracion of [30, 60, 90]) {
      const horas = calcularHoras({
        apertura: hm(8),
        cierre: hm(18),
        ocupados: [{ inicio: hm(12), fin: hm(13) }],
        duracion,
        intervalo: 30,
        servicioMasCorto: 30,
      });
      assert.ok(horas.length > 0);
      for (const { inicio } of horas) {
        assert.ok(inicio + duracion <= hm(12) || inicio >= hm(13), `${duracion} min a las ${inicio / 60} cruza el almuerzo`);
        assert.ok(inicio >= hm(8) && inicio + duracion <= hm(18), 'queda dentro del horario');
      }
      // Siempre se ofrece la última hora antes del almuerzo y la primera después, y quedan "pegadas"
      assert.deepEqual(horas.find((h) => h.inicio === hm(12) - duracion), { inicio: hm(12) - duracion, pegada: true });
      assert.deepEqual(horas.find((h) => h.inicio === hm(13)), { inicio: hm(13), pegada: true });
    }
  });

  test('un servicio de una hora con almuerzo de 12 a 13: el último turno de la mañana es a las 11:00', () => {
    const horas = calcularHoras({
      apertura: hm(8),
      cierre: hm(18),
      ocupados: [{ inicio: hm(12), fin: hm(13) }],
      duracion: 60,
      intervalo: 30,
      servicioMasCorto: 30,
    });
    const minutos = inicios(horas);
    assert.ok(minutos.includes(hm(11)) && minutos.includes(hm(13)));
    assert.ok(!minutos.some((m) => [hm(11, 30), hm(12), hm(12, 30)].includes(m)));
    assert.equal(minutos.at(-1), hm(17), 'termina justo al cierre');
  });

  test('si el servicio no cabe en ningún hueco no se ofrece nada', () => {
    assert.deepEqual(
      calcularHoras({
        apertura: hm(8),
        cierre: hm(12),
        // Huecos de 60, 60 y 30 minutos: ninguno alcanza para 90
        ocupados: [{ inicio: hm(9), fin: hm(10) }, { inicio: hm(11), fin: hm(11, 30) }],
        duracion: 90,
        intervalo: 30,
        servicioMasCorto: 30,
      }),
      [],
    );
  });

  test('para hoy no se ofrecen las horas que ya pasaron', () => {
    const horas = calcularHoras({
      apertura: hm(8),
      cierre: hm(12),
      ocupados: [],
      duracion: 30,
      intervalo: 30,
      servicioMasCorto: 30,
      desde: hm(10, 15),
    });
    assert.deepEqual(inicios(horas), [hm(10, 30), hm(11), hm(11, 30)]);
  });

  test('respeta el intervalo del negocio (cada 10, 20, 30, 40, 50 o 60 minutos)', () => {
    for (const intervalo of [10, 20, 30, 40, 50, 60]) {
      const horas = calcularHoras({ apertura: hm(8), cierre: hm(12), ocupados: [], duracion: 30, intervalo, servicioMasCorto: 10 });
      for (const { inicio, pegada } of horas) {
        assert.ok(pegada || inicio % intervalo === 0, `intervalo ${intervalo}: ${inicio}`);
      }
      assert.equal(horas[0].inicio, hm(8));
      assert.equal(horas.at(-1)!.inicio, hm(11, 30));
    }
  });
});

// Integración: el almuerzo se configura como un bloqueo semanal del profesional
describe('horas disponibles y almuerzo (API)', () => {
  let ctx: Contexto;
  let token: string;
  const diaSemana = new Date(`${FECHA_FUTURA}T00:00:00Z`).getUTCDay();
  const consultarHoras = async (servicioId: string, fecha = FECHA_FUTURA) => {
    const r = await pedir(ctx, `/api/v1/citas/disponibilidad?empresaId=emp_a&barberoId=barb_a&servicioId=${servicioId}&fecha=${fecha}`);
    assert.equal(r.estado, 200, r.texto);
    return r.json.horas as { inicio: string; hora: string; pegada: boolean }[];
  };
  const reservar = (cambios: Record<string, unknown>) =>
    pedir(ctx, '/api/v1/citas', { method: 'POST', body: reservaValida(cambios) });

  before(async () => {
    ctx = await iniciar();
    token = await iniciarSesion(ctx, 'admin.a', '1234');
    const almuerzo = await pedir(ctx, '/api/v1/bloqueos', {
      method: 'POST',
      token,
      body: { barberoId: 'barb_a', diaSemana, horaInicio: '12:00', horaFin: '13:00', motivo: 'Almuerzo' },
    });
    assert.equal(almuerzo.estado, 201, almuerzo.texto);
  });
  after(() => ctx.cerrar());

  test('sin almuerzo el día completo está libre; con almuerzo no se ofrece ninguna hora que lo cruce', async () => {
    // Al día siguiente (otro día de la semana) no hay almuerzo: el bloqueo semanal es de un solo día de la semana
    const libre = (await consultarHoras('serv_a', fechaEnDias(8))).map((h) => h.inicio);
    assert.ok(libre.includes('12:00') && libre.includes('12:30'));

    // 30 minutos: 11:30 sí (termina a las 12:00), 12:00 y 12:30 no, 13:00 sí
    const treinta = (await consultarHoras('serv_a')).map((h) => h.inicio);
    assert.ok(treinta.includes('11:30') && treinta.includes('13:00'));
    assert.ok(!treinta.includes('12:00') && !treinta.includes('12:30'));

    // 60 minutos: 11:00 sí, 11:30 no, 12:00 no, 12:30 no, 13:00 sí
    const sesenta = await consultarHoras('serv_a_largo');
    const sesentaInicios = sesenta.map((h) => h.inicio);
    assert.ok(sesentaInicios.includes('11:00') && sesentaInicios.includes('13:00'));
    assert.ok(!['11:30', '12:00', '12:30'].some((h) => sesentaInicios.includes(h)));
    assert.equal(sesenta.find((h) => h.inicio === '11:00')?.pegada, true);
    assert.equal(sesenta.find((h) => h.inicio === '13:00')?.pegada, true);
    // Cada hora trae también el formato que usa POST /citas
    assert.equal(sesenta.find((h) => h.inicio === '13:00')?.hora, '01:00 PM');
  });

  test('el almuerzo semanal también vale la semana siguiente y no afecta a otro profesional', async () => {
    const siguiente = fechaEnDias(14);
    const horas = (await consultarHoras('serv_a', siguiente)).map((h) => h.inicio);
    assert.ok(!horas.includes('12:00') && !horas.includes('12:30'));
    const otroBarbero = await pedir(
      ctx,
      `/api/v1/citas/disponibilidad?empresaId=emp_a&barberoId=barb_a2&servicioId=serv_a&fecha=${FECHA_FUTURA}`,
    );
    assert.ok(otroBarbero.json.horas.some((h: { inicio: string }) => h.inicio === '12:00'), 'el otro profesional sí atiende a las 12:00');
  });

  test('reservar encima del almuerzo responde 409 y reservar justo antes o después funciona', async () => {
    const bloqueada = 'El profesional no atiende en ese horario. Por favor elige otra hora.';
    for (const cambios of [
      { hora: '12:00 PM' },
      { hora: '12:30 PM' },
      { hora: '11:30 AM', servicioId: 'serv_a_largo' },
      { hora: '12:00 PM', servicioId: 'serv_a_largo', telefono: '3100000010' },
    ]) {
      const r = await reservar(cambios);
      assert.equal(r.estado, 409, JSON.stringify(cambios));
      assert.deepEqual(r.json, { error: bloqueada });
    }
    const antes = await reservar({ hora: '11:30 AM', telefono: '3100000011' });
    const despues = await reservar({ hora: '01:00 PM', telefono: '3100000012' });
    assert.equal(antes.estado, 201, antes.texto);
    assert.equal(despues.estado, 201, despues.texto);
  });

  test('las reservas hechas quitan sus horas de la lista y dejan "pegadas" las vecinas', async () => {
    const horas = await consultarHoras('serv_a');
    const inicios = horas.map((h) => h.inicio);
    // 11:30 y 13:00 ya están reservadas (prueba anterior)
    assert.ok(!inicios.includes('11:30') && !inicios.includes('13:00'));
    assert.equal(horas.find((h) => h.inicio === '13:30')?.pegada, true, 'queda pegada a la cita de las 13:00');
    assert.equal(horas.find((h) => h.inicio === '11:00')?.pegada, true, 'termina justo cuando empieza la cita de las 11:30');
  });

  test('el público ve el bloqueo del almuerzo, pero no su motivo', async () => {
    const r = await pedir(ctx, '/api/v1/citas/bloqueos?empresaId=emp_a');
    assert.equal(r.estado, 200);
    const almuerzo = r.json.find((b: { barberoId: string; diaSemana: number }) => b.barberoId === 'barb_a' && b.diaSemana === diaSemana);
    assert.deepEqual(
      { horaInicio: almuerzo.horaInicio, horaFin: almuerzo.horaFin, tipo: almuerzo.tipo },
      { horaInicio: '12:00', horaFin: '13:00', tipo: 'semanal' },
    );
    assert.ok(!r.texto.includes('Almuerzo'));
  });

  test('no se puede bloquear una hora que ya tiene una cita', async () => {
    const conCita = await reservar({ fecha: fechaEnDias(5), hora: '03:00 PM', telefono: '3100000013' });
    assert.equal(conCita.estado, 201);
    const bloquear = await pedir(ctx, '/api/v1/bloqueos', {
      method: 'POST',
      token,
      body: { barberoId: 'barb_a', fecha: fechaEnDias(5), horaInicio: '15:00', horaFin: '16:00' },
    });
    assert.equal(bloquear.estado, 409);
    assert.deepEqual(bloquear.json, { error: 'Hay una cita en ese horario' });
  });

  test('para hoy no se ofrecen horas que ya pasaron (según la zona del negocio)', async () => {
    const minutosAntes = minutosAhoraEn(ZONA_POR_DEFECTO);
    const horas = await consultarHoras('serv_a', fechaEnDias(0));
    for (const { inicio } of horas) {
      const [h, m] = inicio.split(':').map(Number);
      assert.ok(h * 60 + m >= minutosAntes, `${inicio} ya pasó`);
    }
  });

  test('rechaza fechas pasadas, más allá de 14 días y servicios de otro profesional que no atiende', async () => {
    const pasada = await pedir(ctx, `/api/v1/citas/disponibilidad?empresaId=emp_a&barberoId=barb_a&servicioId=serv_a&fecha=${fechaEnDias(-1)}`);
    assert.equal(pasada.estado, 400);
    assert.deepEqual(pasada.json, { error: 'No se pueden agendar citas en fechas pasadas' });
    const lejana = await pedir(ctx, `/api/v1/citas/disponibilidad?empresaId=emp_a&barberoId=barb_a&servicioId=serv_a&fecha=${fechaEnDias(15)}`);
    assert.equal(lejana.estado, 400);
    assert.match(lejana.json.error, /^Solo puedes reservar desde hoy hasta 14 días después/);
    const formato = await pedir(ctx, '/api/v1/citas/disponibilidad?empresaId=emp_a&barberoId=barb_a&servicioId=serv_a&fecha=2026-02-31');
    assert.equal(formato.estado, 400);
    assert.deepEqual(formato.json, { error: 'La fecha debe tener el formato AAAA-MM-DD' });
  });
});
