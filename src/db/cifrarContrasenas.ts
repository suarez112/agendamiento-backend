import dotenv from 'dotenv';
import { cargarEntornoBaseDeDatos } from '../config/entorno.js';
import { cifrarContrasena } from '../modules/auth/contrasenas.js';
import { crearPool } from './pool.js';

// npm run db:cifrar-contrasenas
// Reemplaza por bcrypt las contraseñas que aún están en texto plano. El inicio
// de sesión también lo hace al entrar, pero esto cubre a quien nunca entra.
// No se puede deshacer: haz un respaldo de la base antes de ejecutarlo.
dotenv.config({ quiet: true });
const pool = crearPool(cargarEntornoBaseDeDatos());

try {
  const { rows } = await pool.query<{ id: string; password_hash: string }>(
    `SELECT id, password_hash FROM barberos WHERE password_hash !~ '^\\$2[aby]\\$\\d{2}\\$'`,
  );
  for (const { id, password_hash } of rows) {
    // La condición evita pisar un hash que el inicio de sesión haya guardado mientras tanto
    await pool.query('UPDATE barberos SET password_hash = $2 WHERE id = $1 AND password_hash = $3', [
      id,
      await cifrarContrasena(password_hash),
      password_hash,
    ]);
  }
  console.log(`${rows.length} contraseña(s) cifrada(s)`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
