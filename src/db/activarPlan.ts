import dotenv from 'dotenv';
import { cargarEntornoBaseDeDatos } from '../config/entorno.js';
import { buscarSuscripcion } from '../modules/empresas/empresas.repositorio.js';
import { crearPool } from './pool.js';

// npm run dev:activar-plan -- CODIGO mensual|anual
// Activa un plan a una empresa sin pagos reales (no hay pasarela de pagos todavía).
// La fecha de pago es hoy (hora de Colombia) y la empresa queda 'activa' de inmediato.
// El plan dura 1 mes o 1 año contados desde:
// - el fin de la prueba, si paga durante la prueba (no pierde los días gratis que le
//   quedaban; se guardan en dias_prueba_sumados),
// - el fin del plan actual, si renueva antes de que venza (no pierde días),
// - hoy, en cualquier otro caso.
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
           GREATEST(hoy.fecha, CASE e.estado_suscripcion
                                 WHEN 'activa' THEN e.suscripcion_fin
                                 WHEN 'trial' THEN (e.trial_ends_at AT TIME ZONE 'America/Bogota')::date
                               END)
           + CASE $2::varchar WHEN 'mensual' THEN interval '1 month' ELSE interval '1 year' END
         )::date,
         dias_prueba_sumados = CASE e.estado_suscripcion
                                 WHEN 'trial' THEN GREATEST((e.trial_ends_at AT TIME ZONE 'America/Bogota')::date - hoy.fecha, 0)
                                 WHEN 'activa' THEN e.dias_prueba_sumados
                               END
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
        `Fin: ${s.fecha_fin}. Días restantes: ${s.dias_restantes}.` +
        (s.dias_prueba_sumados ? ` Días de prueba sumados: ${s.dias_prueba_sumados}.` : ''),
    );
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
