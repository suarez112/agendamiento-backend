import type pg from 'pg';
import { buscarPlan } from '../../config/planes.js';
import { errores } from '../../shared/errores.js';
import { planInsuficiente } from './suscripcion.js';

export type Periodo = 'mensual' | 'anual';
export type OrigenActivacion = 'panel' | 'comando';

// Deja la empresa 'activa' con el plan de hoy (fecha en la zona del negocio). Sin plan por tamaño de equipo
// conserva el que tiene. Si el equipo activo no cabe en el plan elegido, responde 409 y no cambia nada.
// El plan dura 1 mes o 1 año contados desde:
// - el fin de la prueba, si paga durante la prueba (no pierde los días gratis que le quedaban;
//   se guardan en dias_prueba_sumados),
// - el fin del plan actual, si renueva antes de que venza (no pierde días),
// - hoy, en cualquier otro caso.
// Debe correr dentro de una transacción: bloquea la fila de la empresa mientras decide.
// Cada activación queda en el historial (activaciones_plan) con el precio del plan de ese momento,
// para estimar los ingresos. Devuelve false si la empresa no existe.
export const activarPlanEmpresa = async (
  tx: pg.PoolClient,
  empresaId: string,
  periodo: Periodo,
  planEquipoId: string | null,
  origen: OrigenActivacion = 'comando',
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
                                 WHEN 'trial' THEN (e.trial_ends_at AT TIME ZONE e.zona_horaria)::date
                               END)
           + CASE $2::varchar WHEN 'mensual' THEN interval '1 month' ELSE interval '1 year' END
         )::date,
         dias_prueba_sumados = CASE e.estado_suscripcion
                                 WHEN 'trial' THEN GREATEST((e.trial_ends_at AT TIME ZONE e.zona_horaria)::date - hoy.fecha, 0)
                                 WHEN 'activa' THEN e.dias_prueba_sumados
                               END
     FROM (SELECT (now() AT TIME ZONE zona_horaria)::date AS fecha FROM empresas WHERE id = $1) hoy
     WHERE e.id = $1`,
    [empresaId, periodo, planEquipo?.id ?? null],
  );
  // Plan final (puede ser el que ya tenía) y precio de hoy, que es lo que se estima como ingreso
  const final = (
    await tx.query<{ plan_equipo: string; codigo_acceso: string; nombre: string; fecha: string }>(
      `SELECT plan_equipo, codigo_acceso, nombre, to_char((now() AT TIME ZONE zona_horaria)::date, 'YYYY-MM-DD') AS fecha
       FROM empresas WHERE id = $1`,
      [empresaId],
    )
  ).rows[0];
  const plan = buscarPlan(final.plan_equipo);
  if (plan) {
    await tx.query(
      `INSERT INTO activaciones_plan (empresa_id, empresa_codigo, empresa_nombre, plan_equipo, periodo, precio, fecha, origen)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)`,
      [
        empresaId,
        final.codigo_acceso,
        final.nombre,
        plan.id,
        periodo,
        periodo === 'mensual' ? plan.precioMensual : plan.precioAnual,
        final.fecha,
        origen,
      ],
    );
  }
  return true;
};
