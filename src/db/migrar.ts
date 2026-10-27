import dotenv from 'dotenv';
import { cargarEntornoMigraciones } from '../config/entorno.js';
import { aplicarMigraciones } from './migraciones.js';
import { crearPool } from './pool.js';

// npm run db:migrate (usa DB_MIGRACION_USER, no el usuario limitado de la app)
dotenv.config({ quiet: true });
const pool = crearPool(cargarEntornoMigraciones());

try {
  const aplicadas = await aplicarMigraciones(pool, {
    alAplicar: (archivo) => console.log(`✔ ${archivo}`),
  });
  console.log(aplicadas.length ? `${aplicadas.length} migración(es) aplicada(s)` : 'La base ya está al día');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
