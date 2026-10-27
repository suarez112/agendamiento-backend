import { cifrarContrasena } from '../modules/auth/contrasenas.js';
import type { Consultable } from './pool.js';

// Reemplaza por bcrypt las contraseñas que aún están en texto plano (lógica de npm run db:cifrar-contrasenas).
// Las tablas que tienen inicio de sesión. Un valor NULL (perfil sin inicio de sesión) no se toca. Un valor vacío
// tampoco se cifra: eso lo convertiría en un hash "válido" de la contraseña vacía; solo se cuenta.
const TABLAS = ['barberos', 'usuarios', 'superadmins'] as const;

export type ResultadoCifrado = { cifradas: number; vacias: number };

export const cifrarContrasenasPendientes = async (db: Consultable): Promise<ResultadoCifrado> => {
  let cifradas = 0;
  let vacias = 0;
  for (const tabla of TABLAS) {
    const { rows } = await db.query<{ id: string; password_hash: string }>(
      `SELECT id, password_hash FROM ${tabla} WHERE password_hash <> '' AND password_hash !~ '^\\$2[aby]\\$\\d{2}\\$'`,
    );
    for (const { id, password_hash } of rows) {
      // La condición evita pisar un hash que se haya guardado mientras tanto
      const { rowCount } = await db.query(`UPDATE ${tabla} SET password_hash = $2 WHERE id = $1 AND password_hash = $3`, [
        id,
        await cifrarContrasena(password_hash),
        password_hash,
      ]);
      cifradas += rowCount ?? 0;
    }
    const { rows: vacios } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla} WHERE password_hash = ''`);
    vacias += vacios[0]?.n ?? 0;
  }
  return { cifradas, vacias };
};
