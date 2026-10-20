import type pg from 'pg';
import { buscarPlan } from '../../config/planes.js';
import { errores } from '../../shared/errores.js';
import { planInsuficiente } from './suscripcion.js';

export type Periodo = 'mensual' | 'anual';

// Deja la empresa 'activa' con el plan de hoy (hora de Colombia). Sin plan por tamaño de equipo
// conserva el que tiene. Si el equipo activo no cabe en el plan elegido, responde 409 y no cambia nada.
// El plan dura 1 mes o 1 año contados desde:
// - el fin de la prueba, si paga durante la prueba (no pierde los días gratis que le quedaban;
//   se guardan en dias_prueba_sumados),
// - el fin del plan actual, si renueva antes de que venza (no pierde días),
// - hoy, en cualquier otro caso.
// Debe correr dentro de una transacción: bloquea la fila de la empresa mientras decide.
// Devuelve false si la empresa no existe.
export const activarPlanEmpresa = async (
  tx: pg.PoolClient,
  empresaId: string,
  periodo: Periodo,
  planEquipoId: string | null,
): Promise<boolean> => {
  const actual = (
    await tx.query<{ activos: number }>(
      `SELECT (SELECT count(*)::int FROM barberos b WHERE b.empresa_id = e.id AND b.activo) AS activos
       FROM empresas e WHERE e.id = $1 FOR UPDATE`,
      [empresaId],
    )
  ).rows[0];
  if (!actual) return false;
  const planEquipo = planEquipoId ? buscarPlan(planEquipoId) : undefined;
  if (planEquipo && actual.activos > planEquipo.cupo) throw errores.conflicto(planInsuficiente(planEquipo, actual.activos));
  await tx.query(
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
     WHERE e.id = $1`,
    [empresaId, periodo, planEquipo?.id ?? null],
  );
  return true;
};
