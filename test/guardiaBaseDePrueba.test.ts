import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { esBaseTemporalDePrueba, leerConfigPruebas } from './apoyo/configuracionPruebas.js';

// S1 — las pruebas nunca usan la base de desarrollo: se niegan a correr si no hay una base
// de pruebas propia o si apunta a la de desarrollo. No necesita PostgreSQL.
const DESARROLLO = { DB_HOST: 'localhost', DB_PORT: '5432', DB_USER: 'postgres', DB_PASSWORD: 'dev', DB_NAME: 'agendamiento_db' };

describe('guardia de la base de pruebas', () => {
  test('sin TEST_DB_NAME se niega a correr y explica qué hacer', () => {
    assert.throws(() => leerConfigPruebas({ ...DESARROLLO }), /TEST_DB_NAME/);
  });

  test('se niega a usar agendamiento_db, sin importar mayúsculas ni espacios', () => {
    for (const nombre of ['agendamiento_db', 'AGENDAMIENTO_DB', '  agendamiento_db  ']) {
      assert.throws(() => leerConfigPruebas({ ...DESARROLLO, TEST_DB_NAME: nombre }), /agendamiento_db/i, nombre);
    }
  });

  test('se niega a usar la misma base que DB_NAME, aunque se llame distinto', () => {
    const env = { ...DESARROLLO, DB_NAME: 'mi_base_test', TEST_DB_NAME: 'mi_base_test' };
    assert.throws(() => leerConfigPruebas(env), /desarrollo/i);
  });

  test('exige que el nombre diga "test" o "prueba"', () => {
    for (const nombre of ['barberia', 'postgres', 'template1', 'produccion']) {
      assert.throws(() => leerConfigPruebas({ ...DESARROLLO, TEST_DB_NAME: nombre }), /test|prueba/i, nombre);
    }
  });

  test('con una base válida usa esa base solo para crear y borrar las temporales', () => {
    const config = leerConfigPruebas({ ...DESARROLLO, TEST_DB_NAME: 'agendamiento_test' });
    assert.equal(config.baseMantenimiento, 'agendamiento_test');
    assert.equal(config.prefijo, 'agendamiento_test_');
    assert.notEqual(config.baseMantenimiento, DESARROLLO.DB_NAME);
  });

  test('sin variables propias usa el servidor y las credenciales de DB_*; con TEST_DB_* las reemplaza', () => {
    const base = leerConfigPruebas({ ...DESARROLLO, TEST_DB_NAME: 'agendamiento_test' });
    assert.deepEqual([base.host, base.port, base.user, base.password], ['localhost', 5432, 'postgres', 'dev']);

    const propio = leerConfigPruebas({
      ...DESARROLLO,
      TEST_DB_NAME: 'agendamiento_test',
      TEST_DB_HOST: '127.0.0.1',
      TEST_DB_PORT: '5433',
      TEST_DB_USER: 'agendamiento_test',
      TEST_DB_PASSWORD: 'solo-pruebas',
    });
    assert.deepEqual([propio.host, propio.port, propio.user, propio.password], ['127.0.0.1', 5433, 'agendamiento_test', 'solo-pruebas']);
  });

  test('solo se pueden borrar las bases temporales que crea la propia suite', () => {
    const config = leerConfigPruebas({ ...DESARROLLO, TEST_DB_NAME: 'agendamiento_test' });
    assert.equal(esBaseTemporalDePrueba(config, 'agendamiento_test_1234_abc'), true);
    for (const nombre of ['agendamiento_db', 'agendamiento_test', 'postgres', 'agendamiento_prueba_1_a', 'otra_agendamiento_test_1_a']) {
      assert.equal(esBaseTemporalDePrueba(config, nombre), false, nombre);
    }
  });
});
