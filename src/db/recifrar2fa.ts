import dotenv from 'dotenv';
import { cargarEntorno } from '../config/entorno.js';
import { recifrarSegundosPasos } from '../modules/superadmin/recifrado.js';
import { registrarComando } from './comandos.js';
import { crearPool } from './pool.js';

// npm run db:recifrar-2fa
// Pasa la clave de la verificación en dos pasos de los superadmins de la llave vieja a TOTP_SECRET, sin que
// tengan que configurar de nuevo su app autenticadora. Antes de B-4 la llave era JWT_SECRET: si no defines
// TOTP_SECRET_ANTERIOR se usa JWT_SECRET como llave vieja. Se puede ejecutar más de una vez sin riesgo.
dotenv.config({ quiet: true });

const entorno = cargarEntorno();
const pool = crearPool(entorno);

try {
  const antigua = process.env.TOTP_SECRET_ANTERIOR?.trim() || entorno.JWT_SECRET;
  const r = await recifrarSegundosPasos(pool, { antigua, nueva: entorno.TOTP_SECRET });
  if (r.recifradas > 0) {
    await registrarComando(pool, { comando: 'db:recifrar-2fa', accion: 'recifrar_2fa', detalle: { claves: r.recifradas } });
  }
  console.log(`${r.recifradas} clave(s) vuelta(s) a cifrar, ${r.yaActualizadas} ya estaban con la llave nueva.`);
  if (r.ilegibles.length > 0) {
    console.error(
      `⚠ No se pudo leer la clave de: ${r.ilegibles.join(', ')} con la llave anterior (JWT_SECRET o TOTP_SECRET_ANTERIOR). ` +
        'Si conservas el valor que tenía JWT_SECRET cuando se creó, ponlo en TOTP_SECRET_ANTERIOR y repite el comando; ' +
        'si no, reinicia su segundo paso con: npm run dev:crear-superadmin -- correo --reiniciar',
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
