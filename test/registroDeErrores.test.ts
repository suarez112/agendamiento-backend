import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import { manejadorErrores } from '../src/shared/http/manejadorErrores.js';
import { datosDeErrorPg, limpiarTexto, registro } from '../src/shared/registro.js';
import { type Contexto, iniciar } from './apoyo/servidor.js';

// Captura lo que se escribe con console.error (los errores siempre se registran, también en las pruebas)
const capturarErrores = async (trabajo: () => Promise<void> | void) => {
  const original = console.error;
  const lineas: string[] = [];
  console.error = (...partes: unknown[]) => void lineas.push(partes.join(' '));
  try {
    await trabajo();
  } finally {
    console.error = original;
  }
  return lineas;
};

// B-7 — los mensajes de error de la base de datos se limpian antes de llegar al registro
describe('registro de errores', () => {
  test('limpiarTexto reemplaza lo que va entre comillas, de cualquier tipo, y recorta', () => {
    assert.equal(
      limpiarTexto('invalid input syntax for type date: "2026-99-99 dato-privado"'),
      'invalid input syntax for type date: "…"',
    );
    assert.equal(limpiarTexto("duplicate key value 'ana@correo.com'"), 'duplicate key value "…"');
    assert.equal(limpiarTexto('la sintaxis de entrada no es válida: «dato-privado»'), 'la sintaxis de entrada no es válida: "…"');
    assert.equal(limpiarTexto('connect ECONNREFUSED 127.0.0.1:5432'), 'connect ECONNREFUSED 127.0.0.1:5432', 'lo demás no se toca');
    assert.equal(limpiarTexto('x'.repeat(1000)).length, 400);
  });

  test('registro.error limpia el mensaje y la pila antes de escribirlos', async () => {
    const lineas = await capturarErrores(() =>
      registro.error('prueba', { mensaje: 'falló con "dato-privado"', pila: 'Error: falló con "dato-privado"\n    at algo (archivo.ts:1:1)', ruta: '/x' }),
    );
    const texto = lineas.join('\n');
    assert.ok(!texto.includes('dato-privado'), texto);
    const registrada = JSON.parse(lineas[0]);
    assert.equal(registrada.mensaje, 'falló con "…"');
    assert.equal(registrada.ruta, '/x', 'los demás campos no cambian');
  });

  test('datosDeErrorPg solo devuelve datos estructurales y nada para errores que no son de la base', () => {
    assert.deepEqual(datosDeErrorPg(new Error('común')), {});
    assert.deepEqual(datosDeErrorPg(null), {});
    const deLaBase = Object.assign(new Error('x'), {
      code: '23502', severity: 'ERROR', table: 'cargos', column: 'fecha', detail: 'La fila contiene (dato-privado)',
    });
    assert.deepEqual(datosDeErrorPg(deLaBase), { codigoPg: '23502', tabla: 'cargos', columna: 'fecha' });
  });
});

describe('errores de la base de datos en el manejador', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  const responder = () => {
    const salida: { estado?: number; cuerpo?: unknown } = {};
    const res = {
      headersSent: false,
      status(estado: number) {
        salida.estado = estado;
        return this;
      },
      json(cuerpo: unknown) {
        salida.cuerpo = cuerpo;
        return this;
      },
    } as unknown as Response;
    return { res, salida };
  };

  test('un valor inválido que la persona escribió no queda en el registro, y la respuesta es genérica', async () => {
    const error = await ctx.pool.query("SELECT 'dato-privado-123'::date").then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error, 'la base debe rechazar el valor');
    assert.ok((error as Error).message.includes('dato-privado-123'), 'el mensaje original sí trae el valor (por eso se limpia)');

    const { res, salida } = responder();
    const lineas = await capturarErrores(() =>
      void manejadorErrores(error, { method: 'GET', path: '/api/v1/algo' } as Request, res, () => undefined),
    );
    assert.equal(salida.estado, 500);
    assert.deepEqual(salida.cuerpo, { error: 'Error interno del servidor' }, 'nada de la base llega a quien consulta');
    const texto = lineas.join('\n');
    assert.ok(!texto.includes('dato-privado-123'), texto);
    const registrada = JSON.parse(lineas[0]);
    assert.equal(registrada.evento, 'error_no_controlado');
    assert.equal(registrada.codigoPg, '22007', 'queda el código de PostgreSQL para poder investigar');
    assert.equal(registrada.ruta, '/api/v1/algo');
  });

  test('un error de restricción deja tabla, columna y restricción, pero no los valores de la fila', async () => {
    const error = await ctx.pool.query("INSERT INTO servicios (id, empresa_id, nombre, duracion_min, precio) VALUES ('s-privado', 'emp_a', NULL, 30, 1)").then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error);
    const lineas = await capturarErrores(() =>
      void manejadorErrores(error, { method: 'POST', path: '/api/v1/servicios' } as Request, responder().res, () => undefined),
    );
    const registrada = JSON.parse(lineas[0]);
    assert.equal(registrada.tabla, 'servicios');
    assert.equal(registrada.columna, 'nombre');
    assert.ok(!lineas.join('\n').includes('s-privado'), 'los valores de la fila (detail) no se registran');
  });
});
