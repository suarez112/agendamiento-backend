import assert from 'node:assert/strict';
import { test } from 'node:test';
import { esFechaReal, hora12AMinutos, hora24AMinutos, minutosAHHMM } from '../src/modules/citas/horas.js';

test('hora12AMinutos convierte horas válidas de 12 horas', () => {
  assert.equal(hora12AMinutos('09:40 AM'), 580);
  assert.equal(hora12AMinutos('9:40 AM'), 580);
  assert.equal(hora12AMinutos('12:00 AM'), 0);
  assert.equal(hora12AMinutos('12:15 PM'), 735);
  assert.equal(hora12AMinutos('11:59 PM'), 1439);
});

test('hora12AMinutos rechaza horas imposibles', () => {
  for (const h of ['99:00 AM', '13:00 PM', '00:30 AM', '10:60 AM', '10:00', '10:00 am', '']) {
    assert.equal(hora12AMinutos(h), null, h);
  }
});

test('hora24AMinutos y minutosAHHMM', () => {
  assert.equal(hora24AMinutos('08:00:00'), 480);
  assert.equal(hora24AMinutos('20:30'), 1230);
  assert.equal(minutosAHHMM(580), '09:40');
  assert.equal(minutosAHHMM(0), '00:00');
});

test('esFechaReal solo acepta fechas del calendario', () => {
  assert.equal(esFechaReal('2026-10-18'), true);
  assert.equal(esFechaReal('2028-02-29'), true);
  assert.equal(esFechaReal('2026-02-31'), false);
  assert.equal(esFechaReal('2026-13-01'), false);
  assert.equal(esFechaReal('18/10/2026'), false);
  assert.equal(esFechaReal('0000-01-01'), false);
});
