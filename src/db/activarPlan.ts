import dotenv from 'dotenv';
import { cargarEntornoBaseDeDatos } from '../config/entorno.js';
import { buscarPlan, ID_PLANES } from '../config/planes.js';
import { buscarSuscripcion } from '../modules/empresas/empresas.repositorio.js';
import { planInsuficiente } from '../modules/empresas/suscripcion.js';
import { crearPool, enTransaccion } from './pool.js';

// npm run dev:activar-plan -- CODIGO [basico|equipo|pro] mensual|anual
// Activa un plan a una empresa sin pagos reales (no hay pasarela de pagos todavía).
// Sin plan (basico, equipo o pro) conserva el que tiene. Un plan cuyo cupo no alcanza
// para el equipo activo se rechaza y no cambia nada.
// La fecha de pago es hoy (hora de Colombia) y la empresa queda 'activa' de inmediato.
// El plan dura 1 mes o 1 año contados desde:
// - el fin de la prueba, si paga durante la prueba (no pierde los días gratis que le
//   quedaban; se guardan en dias_prueba_sumados),
// - el fin del plan actual, si renueva antes de que venza (no pierde días),
// - hoy, en cualquier otro caso.
dotenv.config({ quiet: true });

const USO = `Uso: npm run dev:activar-plan -- CODIGO [${ID_PLANES.join('|')}] mensual|anual`;
const argumentos = process.argv.slice(2).map((a) => a.trim().toLowerCase());
const codigo = argumentos[0]?.toUpperCase();
const planEquipo = argumentos.length === 3 ? buscarPlan(argumentos[1]) : undefined;
const plan = argumentos[argumentos.length - 1];

if (
  !codigo ||
  argumentos.length < 2 ||
  argumentos.length > 3 ||
  (argumentos.length === 3 && !planEquipo) ||
  (plan !== 'mensual' && plan !== 'anual')
) {
  console.error(USO);
  process.exit(1);
}

class Rechazo extends Error {}

const pool = crearPool(cargarEntornoBaseDeDatos());

try {
  const rows = await enTransaccion(pool, async (tx) => {
    const actual = (
      await tx.query<{ id: string; activos: number }>(
        `SELECT e.id, (SELECT count(*)::int FROM barberos b WHERE b.empresa_id = e.id AND b.activo) AS activos
         FROM empresas e WHERE e.codigo_acceso = $1 FOR UPDATE`,
        [codigo],
      )
    ).rows[0];
    if (!actual) return [];
    if (planEquipo && actual.activos > planEquipo.cupo) throw new Rechazo(planInsuficiente(planEquipo, actual.activos));
    const { rows: activada } = await tx.query<{ id: string; nombre: string }>(
      `UPDATE empresas e
       SET estado_suscripcion = 'activa',
           plan_suscripcion = $2::varchar,
           fecha_pago = hoy.fecha,
           plan_equipo = COALESCE($3::varchar, e.plan_equipo),
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
      [codigo, plan, planEquipo?.id ?? null],
    );
    return activada;
  });
  if (rows.length === 0) {
    console.error(`No existe un negocio con el código ${codigo}`);
    process.exitCode = 1;
  } else {
    const s = (await buscarSuscripcion(pool, rows[0].id))!;
    console.log(
      `✔ ${rows[0].nombre} (${codigo}): plan ${buscarPlan(s.plan_equipo)?.nombre ?? s.plan_equipo} ${s.plan} activo ` +
        `(cupo ${s.equipo_activo}/${buscarPlan(s.plan_equipo)?.cupo ?? '?'}). Pago: ${s.fecha_pago}. ` +
        `Fin: ${s.fecha_fin}. Días restantes: ${s.dias_restantes}.` +
        (s.dias_prueba_sumados ? ` Días de prueba sumados: ${s.dias_prueba_sumados}.` : ''),
    );
  }
} catch (error) {
  console.error(error instanceof Rechazo ? `✖ ${error.message}` : (error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
