import pg from 'pg';
import type { EntornoBaseDeDatos } from '../config/entorno.js';
import { registro } from '../shared/registro.js';

// Lo que necesita un repositorio: sirve tanto el pool como un cliente dentro de
// una transacción, así la misma consulta funciona en ambos casos.
export type Consultable = pg.Pool | pg.PoolClient;

export const crearPool = (entorno: EntornoBaseDeDatos): pg.Pool => {
  const pool = new pg.Pool({
    host: entorno.DB_HOST,
    port: entorno.DB_PORT,
    user: entorno.DB_USER,
    password: entorno.DB_PASSWORD,
    database: entorno.DB_NAME,
    max: entorno.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // Un cliente inactivo que se cae no debe tumbar el proceso
  pool.on('error', (error) => registro.error('pg_cliente_inactivo', { mensaje: error.message }));
  return pool;
};

// Ejecuta "trabajo" en una transacción: o se guarda todo, o nada
export const enTransaccion = async <T>(
  pool: pg.Pool,
  trabajo: (cliente: pg.PoolClient) => Promise<T>,
): Promise<T> => {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await trabajo(cliente);
    await cliente.query('COMMIT');
    cliente.release();
    return resultado;
  } catch (error) {
    try {
      await cliente.query('ROLLBACK');
      cliente.release();
    } catch (errorRollback) {
      // La conexión quedó en mal estado: se descarta en lugar de devolverla al pool
      cliente.release(errorRollback as Error);
    }
    throw error;
  }
};

// Códigos de error de PostgreSQL que la API traduce a respuestas claras
export const CODIGO_PG = {
  violacionExclusion: '23P01',
  violacionUnica: '23505',
  violacionLlaveForanea: '23503',
  violacionCheck: '23514',
} as const;

export const esErrorPg = (error: unknown, codigo: string): boolean =>
  error instanceof Error && (error as { code?: unknown }).code === codigo;
