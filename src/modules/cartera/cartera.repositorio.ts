import type { Consultable } from '../../db/pool.js';

export type FilaCartera = {
  barbero_id: string;
  nombre: string;
  activo: boolean;
  porcentaje_ganancia: string;
  citas: number;
  ventas: string;
  ganancia: string;
};

// Citas completadas entre dos fechas (incluidas), agrupadas por profesional.
// La ganancia de cada cita usa el porcentaje guardado al completarla
// (citas.porcentaje_ganancia, migración 006). porcentaje_ganancia es el
// porcentaje actual del profesional, solo informativo. Incluye a quienes ya
// fueron eliminados del equipo si atendieron citas en ese rango.
// barberoId null = todo el equipo del negocio.
export const resumenPorProfesional = async (
  db: Consultable,
  p: { empresaId: string; desde: string; hasta: string; barberoId: string | null },
) =>
  (
    await db.query<FilaCartera>(
      `SELECT b.id AS barbero_id, b.nombre, b.activo, b.porcentaje_ganancia,
              count(*)::int AS citas,
              sum(c.precio) AS ventas,
              round(sum(c.precio * c.porcentaje_ganancia / 100), 2) AS ganancia
       FROM citas c
       JOIN barberos b ON b.id = c.barbero_id
       WHERE c.empresa_id = $1 AND c.estado = 'COMPLETADA'
         AND c.fecha BETWEEN $2::date AND $3::date
         AND ($4::varchar IS NULL OR c.barbero_id = $4)
       GROUP BY b.id
       ORDER BY ventas DESC, b.nombre`,
      [p.empresaId, p.desde, p.hasta, p.barberoId],
    )
  ).rows;

export type Periodo = 'hoy' | 'semana' | 'mes';

// Fechas (AAAA-MM-DD) de un período con la fecha actual de Colombia: hoy; la semana
// de lunes a domingo; el mes del día 1 al último día.
export const fechasDePeriodo = async (db: Consultable, periodo: Periodo) =>
  (
    await db.query<{ desde: string; hasta: string }>(
      `SELECT to_char(desde, 'YYYY-MM-DD') AS desde, to_char(hasta, 'YYYY-MM-DD') AS hasta
       FROM (
         SELECT CASE $1::varchar
                  WHEN 'hoy' THEN hoy
                  WHEN 'semana' THEN date_trunc('week', hoy)::date
                  ELSE date_trunc('month', hoy)::date
                END AS desde,
                CASE $1::varchar
                  WHEN 'hoy' THEN hoy
                  WHEN 'semana' THEN date_trunc('week', hoy)::date + 6
                  ELSE (date_trunc('month', hoy) + interval '1 month - 1 day')::date
                END AS hasta
         FROM (SELECT (now() AT TIME ZONE 'America/Bogota')::date AS hoy) h
       ) p`,
      [periodo],
    )
  ).rows[0];
