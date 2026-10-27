import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type pg from 'pg';

// Las migraciones son archivos numerados en db/migraciones. Cada una corre en su
// propia transacción y queda anotada en schema_migrations para no repetirse.
// Casi todas son SQL (.sql); una .ts exporta por defecto una función que recibe la
// conexión de esa transacción, para cambios de datos que SQL no puede hacer bien
// (ej. 011: pasar los teléfonos a E.164 con libphonenumber-js).
const CARPETA = fileURLToPath(new URL('../../db/migraciones/', import.meta.url));

// Evita que dos procesos migren la misma base al mismo tiempo
const LLAVE_BLOQUEO = 727_274_001;

type Opciones = {
  // Aplica solo hasta esta versión (incluida), ej. "001". Útil para pruebas.
  hasta?: string;
  alAplicar?: (version: string) => void;
};

export const aplicarMigraciones = async (pool: pg.Pool, opciones: Opciones = {}) => {
  const archivos = (await readdir(CARPETA)).filter((a) => /^\d{3}_.+\.(sql|ts)$/.test(a)).sort();
  const cliente = await pool.connect();
  const aplicadas: string[] = [];
  try {
    await cliente.query('SELECT pg_advisory_lock($1)', [LLAVE_BLOQUEO]);
    await cliente.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version varchar PRIMARY KEY,
         nombre varchar NOT NULL,
         aplicada_en timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const yaAplicadas = new Set(
      (await cliente.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
        (r) => r.version,
      ),
    );

    for (const archivo of archivos) {
      const version = archivo.slice(0, 3);
      if (opciones.hasta && version > opciones.hasta) break;
      if (yaAplicadas.has(version)) continue;

      try {
        await cliente.query('BEGIN');
        if (archivo.endsWith('.ts')) {
          const modulo = (await import(pathToFileURL(`${CARPETA}${archivo}`).href)) as {
            default: (db: pg.PoolClient) => Promise<void>;
          };
          await modulo.default(cliente);
        } else {
          await cliente.query(await readFile(`${CARPETA}${archivo}`, 'utf8'));
        }
        await cliente.query('INSERT INTO schema_migrations (version, nombre) VALUES ($1, $2)', [
          version,
          archivo,
        ]);
        await cliente.query('COMMIT');
      } catch (error) {
        await cliente.query('ROLLBACK');
        throw new Error(`Falló la migración ${archivo}: ${(error as Error).message}`, {
          cause: error,
        });
      }
      aplicadas.push(version);
      opciones.alAplicar?.(archivo);
    }
  } finally {
    await cliente.query('SELECT pg_advisory_unlock($1)', [LLAVE_BLOQUEO]).catch(() => {});
    cliente.release();
  }
  return aplicadas;
};
