import type pg from 'pg';
import { type Periodo, planParaPersonas, precioPara } from '../../config/planes.js';
import { contarEquipoCobrable, marcarCargosPagados } from './cobro.js';

export type { Periodo };
export type OrigenActivacion = 'panel' | 'comando' | 'pasarela' | 'manual';

// Lo que realmente se cobró (pasarela): profesionales cubiertos y precio pagado. Sin esto, salen del equipo de hoy.
export type PagoRecibido = { profesionales: number; precio: number };

// Deja la empresa 'activa' con el plan de hoy (fecha en la zona del negocio). El precio sale de los
// profesionales que atienden clientes en este momento (mínimo uno) y el nivel, de ese número.
// Pagar el plan también deja pagados los cargos proporcionales pendientes: el equipo actual ya va incluido.
// El plan dura 1 mes o 1 año contados desde:
// - el fin de la prueba, si paga durante la prueba (no pierde los días gratis que le quedaban;
//   se guardan en dias_prueba_sumados),
// - el fin del plan actual, si renueva antes de que venza (no pierde días),
// - hoy, en cualquier otro caso.
// Debe correr dentro de una transacción: bloquea la fila de la empresa mientras decide.
// Cada activación queda en el historial (activaciones_plan) con el precio de ese momento y los
// profesionales que cubría, para estimar los ingresos. Devuelve false si la empresa no existe.
export const activarPlanEmpresa = async (
  tx: pg.PoolClient,
  empresaId: string,
  periodo: Periodo,
  origen: OrigenActivacion = 'comando',
  pago?: PagoRecibido,
): Promise<boolean> => {
  const existe = (await tx.query('SELECT 1 FROM empresas WHERE id = $1 FOR UPDATE', [empresaId])).rowCount;
  if (!existe) return false;
  const { cobrados } = await contarEquipoCobrable(tx, empresaId);
  const profesionales = pago?.profesionales ?? Math.max(cobrados, 1);
  await tx.query(
    `UPDATE empresas e
     SET estado_suscripcion = 'activa',
         plan_suscripcion = $2::varchar,
         fecha_pago = hoy.fecha,
         plan_equipo = $3::varchar,
         profesionales_pagados = $4::int,
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
    [empresaId, periodo, planParaPersonas(profesionales).id, profesionales],
  );
  // Con un pago de la pasarela, los cargos pendientes solo quedan cubiertos si lo pagado alcanza para el equipo de hoy
  if (profesionales >= cobrados) await marcarCargosPagados(tx, empresaId, 'activacion');
  const final = (
    await tx.query<{ codigo_acceso: string; nombre: string; fecha: string }>(
      `SELECT codigo_acceso, nombre, to_char((now() AT TIME ZONE zona_horaria)::date, 'YYYY-MM-DD') AS fecha
       FROM empresas WHERE id = $1`,
      [empresaId],
    )
  ).rows[0];
  await tx.query(
    `INSERT INTO activaciones_plan (empresa_id, empresa_codigo, empresa_nombre, plan_equipo, periodo, precio, fecha, origen, profesionales)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9)`,
    [
      empresaId,
      final.codigo_acceso,
      final.nombre,
      planParaPersonas(profesionales).id,
      periodo,
      pago?.precio ?? precioPara(profesionales, periodo),
      final.fecha,
      origen,
      profesionales,
    ],
  );
  return true;
};
