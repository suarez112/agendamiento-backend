import { createInterface } from 'node:readline/promises';
import dotenv from 'dotenv';
import { z } from 'zod';
import { cargarEntornoBaseDeDatos } from '../config/entorno.js';
import * as repositorio from '../modules/superadmin/superadmin.repositorio.js';
import { negarEnProduccion, registrarComando } from './comandos.js';
import { crearPool, enTransaccion } from './pool.js';

// npm run dev:eliminar-superadmin -- correo
// Elimina un superadmin (por ejemplo uno creado por error). Pide confirmación y nunca borra al último:
// sin superadmins no habría forma de entrar al panel. El registro de actividad no se toca.
dotenv.config({ quiet: true });
negarEnProduccion('dev:eliminar-superadmin');

const USO = 'Uso: npm run dev:eliminar-superadmin -- correo';
const argumentos = process.argv.slice(2);
const correo = z.email().max(254).safeParse(argumentos[0]?.trim().toLowerCase());

if (argumentos.length !== 1 || !correo.success) {
  console.error(USO);
  process.exit(1);
}

const pool = crearPool(cargarEntornoBaseDeDatos());

try {
  const correos = await repositorio.listarCorreosSuperadmin(pool);
  if (!correos.some((c) => c.toLowerCase() === correo.data)) {
    console.error(`✖ No existe un superadmin con el correo ${correo.data}.`);
    process.exitCode = 1;
  } else if (correos.length <= 1) {
    console.error('✖ Es el único superadmin y no se puede eliminar: nadie más podría entrar al panel. Crea otro antes.');
    process.exitCode = 1;
  } else {
    const consola = createInterface({ input: process.stdin, output: process.stdout });
    const respuesta = (await consola.question(`¿Eliminar al superadmin ${correo.data}? No se puede deshacer. (s/N) `)).trim().toLowerCase();
    consola.close();
    if (respuesta !== 's' && respuesta !== 'si' && respuesta !== 'sí') {
      console.log('Cancelado: no se eliminó nada.');
    } else {
      // La verificación del último se repite dentro de la transacción, con las filas bloqueadas
      const resultado = await enTransaccion(pool, async (tx) => {
        const r = await repositorio.eliminarSuperadmin(tx, correo.data);
        if (r === 'eliminado') {
          await registrarComando(tx, { comando: 'dev:eliminar-superadmin', accion: 'eliminar_superadmin', detalle: { correo: correo.data } });
        }
        return r;
      });
      if (resultado === 'eliminado') {
        const restantes = await repositorio.listarCorreosSuperadmin(pool);
        console.log(`✔ Superadmin ${correo.data} eliminado. Quedan: ${restantes.join(', ')}`);
      } else {
        console.error(
          resultado === 'ultimo' ? '✖ Es el único superadmin y no se puede eliminar.' : `✖ No existe un superadmin con el correo ${correo.data}.`,
        );
        process.exitCode = 1;
      }
    }
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
