import { ZONA_PLATAFORMA } from '../config/plataforma.js';
import dotenv from 'dotenv';
import { cargarEntornoBaseDeDatos } from '../config/entorno.js';
import { ESTADOS_PQRS, type EstadoPqrs } from '../modules/pqrs/pqrs.repositorio.js';
import { negarEnProduccion, registrarComando } from './comandos.js';
import { crearPool } from './pool.js';

// npm run dev:pqrs -- listar [estado]
// npm run dev:pqrs -- responder RADICADO estado "texto de la respuesta"
// Lista las PQRS (las más antiguas sin resolver primero) o cambia el estado de una con su respuesta.
// Estados: recibida | en_proceso | resuelta | cerrada. La respuesta es opcional; si no se envía, se conserva la anterior.
dotenv.config({ quiet: true });

const USO = `Uso:
  npm run dev:pqrs -- listar [${ESTADOS_PQRS.join('|')}]
  npm run dev:pqrs -- responder RADICADO ${ESTADOS_PQRS.join('|')} ["respuesta"]`;

const [orden, ...resto] = process.argv.slice(2);
// Responder cambia el estado y el texto que ve quien radicó; en producción se hace desde el panel del superadmin
if (orden === 'responder') negarEnProduccion('dev:pqrs responder');
const pool = crearPool(cargarEntornoBaseDeDatos());
const esEstado = (valor: string | undefined): valor is EstadoPqrs => ESTADOS_PQRS.includes(valor as EstadoPqrs);

try {
  if (orden === 'listar' && resto.length <= 1 && (resto[0] === undefined || esEstado(resto[0]?.toLowerCase()))) {
    const estado = resto[0]?.toLowerCase() ?? null;
    const { rows } = await pool.query(
      `SELECT radicado, tipo, estado, to_char(creado_en AT TIME ZONE '${ZONA_PLATAFORMA}', 'YYYY-MM-DD HH24:MI') AS fecha,
              nombre, contacto, mensaje, respuesta
       FROM pqrs WHERE $1::varchar IS NULL OR estado = $1
       ORDER BY (estado IN ('resuelta', 'cerrada')), prioridad, fecha_limite, creado_en`,
      [estado],
    );
    if (rows.length === 0) console.log('No hay PQRS' + (estado ? ` en estado ${estado}` : ''));
    for (const p of rows) {
      console.log(`${p.radicado} · ${p.tipo} · ${p.estado} · ${p.fecha}`);
      console.log(`  De: ${p.nombre} (${p.contacto})`);
      console.log(`  Mensaje: ${p.mensaje}`);
      if (p.respuesta) console.log(`  Respuesta: ${p.respuesta}`);
    }
  } else if (orden === 'responder' && resto.length >= 2 && resto.length <= 3 && esEstado(resto[1]?.toLowerCase())) {
    const [radicado, estado, respuesta] = [resto[0].toUpperCase(), resto[1].toLowerCase(), resto[2]?.trim() || null];
    if (respuesta && respuesta.length > 2000) throw new Error('La respuesta admite máximo 2000 caracteres');
    const { rows } = await pool.query(
      `UPDATE pqrs
       SET estado = $2, respuesta = COALESCE($3, respuesta),
           respondida_en = CASE WHEN $3::varchar IS NOT NULL THEN now() ELSE respondida_en END,
           actualizado_en = now()
       WHERE radicado = $1
       RETURNING radicado, estado, respuesta`,
      [radicado, estado, respuesta],
    );
    if (rows.length === 0) {
      console.error(`No existe una PQRS con el radicado ${radicado}`);
      process.exitCode = 1;
    } else {
      await registrarComando(pool, {
        comando: 'dev:pqrs',
        accion: 'responder_pqrs',
        referencia: rows[0].radicado,
        detalle: { estado: rows[0].estado, conRespuesta: Boolean(respuesta) },
      });
      console.log(`✔ ${rows[0].radicado}: estado ${rows[0].estado}.` + (rows[0].respuesta ? ` Respuesta: ${rows[0].respuesta}` : ' Sin respuesta.'));
    }
  } else {
    console.error(USO);
    process.exitCode = 1;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
