import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cargarEntorno, proveedorDePagoActivo } from '../src/config/entorno.js';
import { crearProveedorSimulado } from '../src/modules/pagos/proveedorSimulado.js';

const BASE = {
  DB_HOST: 'localhost',
  DB_USER: 'u',
  DB_PASSWORD: 'p',
  DB_NAME: 'n',
  JWT_SECRET: 'a'.repeat(40),
  RECUPERACION_SECRET: 'b'.repeat(40),
  TOTP_SECRET: 'c'.repeat(40),
};
const LLAVES_PROD = {
  WOMPI_LLAVE_PUBLICA: 'pub_prod_x',
  WOMPI_LLAVE_PRIVADA: 'prv_prod_x',
  WOMPI_SECRETO_EVENTOS: 'prod_events_x',
  WOMPI_SECRETO_INTEGRIDAD: 'prod_integrity_x',
};
const LLAVES_PRUEBA = {
  WOMPI_LLAVE_PUBLICA: 'pub_test_x',
  WOMPI_LLAVE_PRIVADA: 'prv_test_x',
  WOMPI_SECRETO_EVENTOS: 'test_events_x',
  WOMPI_SECRETO_INTEGRIDAD: 'test_integrity_x',
};
const cargar = (extra: Record<string, string>) => cargarEntorno({ ...BASE, ...extra } as NodeJS.ProcessEnv);

describe('pagos: configuración del entorno', () => {
  test('fuera de producción el proveedor por defecto es el simulado', () => {
    assert.equal(proveedorDePagoActivo(cargar({ NODE_ENV: 'development' })), 'simulado');
    assert.equal(proveedorDePagoActivo(cargar({ NODE_ENV: 'test' })), 'simulado');
  });

  test('en producción no hay proveedor por defecto: los pagos quedan desactivados y el servidor arranca', () => {
    assert.equal(proveedorDePagoActivo(cargar({ NODE_ENV: 'production' })), undefined);
  });

  test('en producción se niega a arrancar con el proveedor simulado', () => {
    assert.throws(() => cargar({ NODE_ENV: 'production', PROVEEDOR_PAGO: 'simulado' }), /PROVEEDOR_PAGO: el proveedor simulado no puede usarse en producción/);
  });

  test('en producción se niega a arrancar con llaves de prueba, aunque no se elija wompi', () => {
    assert.throws(
      () => cargar({ NODE_ENV: 'production', PROVEEDOR_PAGO: 'wompi', URL_PAGOS: 'https://app.test/pagos', ...LLAVES_PRUEBA }),
      /llave de prueba \(sandbox\)/,
    );
    assert.throws(() => cargar({ NODE_ENV: 'production', WOMPI_SECRETO_EVENTOS: 'test_events_x' }), /WOMPI_SECRETO_EVENTOS: es una llave de prueba/);
  });

  test('en producción con wompi exige las cuatro llaves de producción y URL_PAGOS', () => {
    const prod = { NODE_ENV: 'production', PROVEEDOR_PAGO: 'wompi', URL_PAGOS: 'https://app.test/pagos', ...LLAVES_PROD };
    assert.equal(proveedorDePagoActivo(cargar(prod)), 'wompi');
    for (const llave of Object.keys(LLAVES_PROD)) {
      const { [llave]: _quitada, ...resto } = prod as Record<string, string>;
      assert.throws(() => cargar(resto), new RegExp(`${llave}: falta`), llave);
      assert.throws(() => cargar({ ...prod, [llave]: 'valor-sin-prefijo' }), new RegExp(`${llave}: en producción debe ser una llave de producción`), llave);
    }
    const { URL_PAGOS: _u, ...sinUrl } = prod;
    assert.throws(() => cargar(sinUrl), /URL_PAGOS: falta/);
  });

  test('con wompi fuera de producción también exige las llaves (aunque sean de prueba)', () => {
    assert.throws(() => cargar({ NODE_ENV: 'development', PROVEEDOR_PAGO: 'wompi' }), /WOMPI_LLAVE_PUBLICA: falta/);
    assert.equal(cargar({ NODE_ENV: 'development', PROVEEDOR_PAGO: 'wompi', ...LLAVES_PRUEBA }).PROVEEDOR_PAGO, 'wompi');
  });

  test('URL_PAGOS debe ser una dirección http(s) y se le quita la barra final', () => {
    assert.equal(cargar({ URL_PAGOS: 'https://app.test/pagos/' }).URL_PAGOS, 'https://app.test/pagos');
    assert.throws(() => cargar({ URL_PAGOS: 'javascript:alert(1)' }), /URL_PAGOS/);
  });

  test('el proveedor simulado se niega a crearse con NODE_ENV=production', () => {
    assert.throws(() => crearProveedorSimulado({ pool: {} as never, nodeEnv: 'production', urlBase: 'http://x' }), /simulado no puede usarse con NODE_ENV=production/);
  });
});
