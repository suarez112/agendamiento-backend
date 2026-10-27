import type { Consultable } from '../../db/pool.js';
import { cifrarSecreto, descifrarSecreto } from './totp.js';

// Vuelve a cifrar la clave de la verificación en dos pasos de cada superadmin con una llave nueva (TOTP_SECRET),
// sin cambiar la clave en sí: la app autenticadora que ya tienen configurada sigue funcionando, no hay que
// escanear un QR nuevo. Es idempotente: las claves que ya están cifradas con la llave nueva no se tocan.
export type ResultadoRecifrado = {
  recifradas: number;
  yaActualizadas: number;
  // Correos cuya clave no se pudo leer con ninguna de las dos llaves (hay que reiniciar su segundo paso)
  ilegibles: string[];
};

export const recifrarSegundosPasos = async (
  db: Consultable,
  llaves: { antigua: string; nueva: string },
): Promise<ResultadoRecifrado> => {
  const { rows } = await db.query<{ id: string; correo: string; totp_secreto: string }>(
    'SELECT id, correo, totp_secreto FROM superadmins ORDER BY correo',
  );
  const resultado: ResultadoRecifrado = { recifradas: 0, yaActualizadas: 0, ilegibles: [] };
  for (const fila of rows) {
    if (descifrarSecreto(fila.totp_secreto, llaves.nueva) !== null) {
      resultado.yaActualizadas += 1;
      continue;
    }
    const claro = descifrarSecreto(fila.totp_secreto, llaves.antigua);
    if (claro === null) {
      resultado.ilegibles.push(fila.correo);
      continue;
    }
    // La condición evita pisar una clave que se haya cambiado mientras tanto
    const { rowCount } = await db.query('UPDATE superadmins SET totp_secreto = $3 WHERE id = $1 AND totp_secreto = $2', [
      fila.id,
      fila.totp_secreto,
      cifrarSecreto(claro, llaves.nueva),
    ]);
    if (rowCount) resultado.recifradas += 1;
  }
  return resultado;
};
