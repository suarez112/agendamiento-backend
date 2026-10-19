import dotenv from 'dotenv';
import { cargarEntornoBaseDeDatos } from '../config/entorno.js';
import { buscarSuscripcion } from '../modules/empresas/empresas.repositorio.js';
import { crearPool } from './pool.js';

// npm run dev:activar-plan -- CODIGO mensual|anual
// Activa un plan a una empresa sin pagos reales (no hay pasarela de pagos todavía).
// La fecha de pago es hoy (hora de Colombia). El plan dura 1 mes o 1 año: desde
// hoy, o desde el fin del plan actual si aún no ha vencido (así una renovación
// anticipada no pierde días).
dotenv.config({ quiet: true });

const USO = 'Uso: npm run dev:activar-plan -- CODIGO mensual|anual';
const [codigoArg, planArg] = process.argv.slice(2);
const codigo = codigoArg?.trim().toUpperCase();
const plan = planArg?.trim().toLowerCase();

if (!codigo || (plan !== 'mensual' && plan !== 'anual')) {
  console.error(USO);
  process.exit(1);
}

const pool = crearPool(cargarEntornoBaseDeDatos());

try {
  const { rows } = await pool.query<{ id: string; nombre: string }>(
    `UPDATE empresas e
     SET estado_suscripcion = 'activa',
         plan_suscripcion = $2::varchar,
         fecha_pago = hoy.fecha,
         suscripcion_fin = (
           GREATEST(hoy.fecha, CASE WHEN e.estado_suscripcion = 'activa' THEN e.suscripcion_fin END)
           + CASE $2::varchar WHEN 'mensual' THEN interval '1 month' ELSE interval '1 year' END
         )::date
     FROM (SELECT (now() AT TIME ZONE 'America/Bogota')::date AS fecha) hoy
     WHERE e.codigo_acceso = $1
     RETURNING e.id, e.nombre`,
    [codigo, plan],
  );
  if (rows.length === 0) {
    console.error(`No existe un negocio con el código ${codigo}`);
    process.exitCode = 1;
  } else {
    const s = (await buscarSuscripcion(pool, rows[0].id))!;
    console.log(
      `✔ ${rows[0].nombre} (${codigo}): plan ${s.plan} activo. Pago: ${s.fecha_pago}. ` +
        `Fin: ${s.fecha_fin}. Días restantes: ${s.dias_restantes}.`,
    );
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
