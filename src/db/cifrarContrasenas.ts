import dotenv from 'dotenv';
import { cargarEntornoBaseDeDatos } from '../config/entorno.js';
import { cifrarContrasena } from '../modules/auth/contrasenas.js';
import { crearPool } from './pool.js';

// npm run db:cifrar-contrasenas
// Reemplaza por bcrypt las contraseñas que aún están en texto plano. Desde M-3 el
// inicio de sesión ya no las acepta: quien siga con una no puede entrar hasta que
// se cifre aquí (o se le cambie la contraseña).
// No se puede deshacer: haz un respaldo de la base antes de ejecutarlo.
dotenv.config({ quiet: true });
const pool = crearPool(cargarEntornoBaseDeDatos());

// Las tablas que tienen inicio de sesión. Un valor NULL (perfil sin inicio de sesión) no se toca.
// Un valor vacío tampoco se cifra: eso lo convertiría en un hash "válido" de la contraseña vacía;
// solo se avisa.
const TABLAS = ['barberos', 'usuarios', 'superadmins'] as const;

try {
  let total = 0;
  let vacias = 0;
  for (const tabla of TABLAS) {
    const { rows } = await pool.query<{ id: string; password_hash: string }>(
      `SELECT id, password_hash FROM ${tabla} WHERE password_hash <> '' AND password_hash !~ '^\\$2[aby]\\$\\d{2}\\$'`,
    );
    for (const { id, password_hash } of rows) {
      // La condición evita pisar un hash que se haya guardado mientras tanto
      await pool.query(`UPDATE ${tabla} SET password_hash = $2 WHERE id = $1 AND password_hash = $3`, [
        id,
        await cifrarContrasena(password_hash),
        password_hash,
      ]);
    }
    total += rows.length;
    const { rows: vacios } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${tabla} WHERE password_hash = ''`,
    );
    vacias += vacios[0]?.n ?? 0;
  }
  console.log(`${total} contraseña(s) cifrada(s)`);
  if (vacias > 0) {
    console.error(`⚠ ${vacias} cuenta(s) con la contraseña vacía: no se cifraron; cámbiales la contraseña.`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
