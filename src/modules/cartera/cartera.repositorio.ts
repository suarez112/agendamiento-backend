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

// Día del registro de la empresa y hoy, los dos con la fecha de Colombia (AAAA-MM-DD).
// fecha_registro es null en empresas sin fecha de creación.
export const limitesDeRango = async (db: Consultable, empresaId: string) =>
  (
    await db.query<{ fecha_registro: string | null; hoy: string }>(
      `SELECT to_char((created_at::timestamptz AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD') AS fecha_registro,
              to_char((now() AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD') AS hoy
       FROM empresas WHERE id = $1`,
      [empresaId],
    )
  ).rows[0];

type FiltroCartera = { empresaId: string; desde: string; hasta: string; barberoId: string | null };
const parametros = (p: FiltroCartera) => [p.empresaId, p.desde, p.hasta, p.barberoId];

// Ventas y citas completadas de cada día del rango (los días sin citas llegan con ceros)
export const ventasPorDia = async (db: Consultable, p: FiltroCartera) =>
  (
    await db.query<{ fecha: string; ventas: string; citas: number }>(
      `SELECT to_char(d.dia, 'YYYY-MM-DD') AS fecha, coalesce(sum(c.precio), 0) AS ventas, count(c.id)::int AS citas
       FROM generate_series($2::date::timestamp, $3::date::timestamp, interval '1 day') AS d(dia)
       LEFT JOIN citas c ON c.fecha = d.dia::date AND c.empresa_id = $1 AND c.estado = 'COMPLETADA'
         AND ($4::varchar IS NULL OR c.barbero_id = $4)
       GROUP BY d.dia ORDER BY d.dia`,
      parametros(p),
    )
  ).rows;

// Servicios de las citas completadas, los más vendidos primero
export const serviciosMasVendidos = async (db: Consultable, p: FiltroCartera, limite: number) =>
  (
    await db.query<{ servicio_id: string | null; nombre: string; cantidad: number; ventas: string }>(
      `SELECT c.servicio_id, coalesce(s.nombre, 'Servicio eliminado') AS nombre, count(*)::int AS cantidad, sum(c.precio) AS ventas
       FROM citas c LEFT JOIN servicios s ON s.id = c.servicio_id
       WHERE c.empresa_id = $1 AND c.estado = 'COMPLETADA' AND c.fecha BETWEEN $2::date AND $3::date
         AND ($4::varchar IS NULL OR c.barbero_id = $4)
       GROUP BY c.servicio_id, s.nombre
       ORDER BY cantidad DESC, ventas DESC, nombre
       LIMIT ${Math.trunc(limite)}`,
      parametros(p),
    )
  ).rows;

// Citas no canceladas del rango por día de la semana (0 = domingo) y hora de inicio
export const ocupacion = async (db: Consultable, p: FiltroCartera) =>
  (
    await db.query<{ dia: number; hora: number; citas: number }>(
      `SELECT extract(dow FROM c.fecha)::int AS dia, extract(hour FROM c.hora_inicio)::int AS hora, count(*)::int AS citas
       FROM citas c
       WHERE c.empresa_id = $1 AND c.estado <> 'CANCELADA' AND c.fecha BETWEEN $2::date AND $3::date
         AND ($4::varchar IS NULL OR c.barbero_id = $4)
       GROUP BY 1, 2`,
      parametros(p),
    )
  ).rows;

// Todas las citas del rango (de cualquier estado) y cuántas se cancelaron
export const conteoCancelaciones = async (db: Consultable, p: FiltroCartera) =>
  (
    await db.query<{ total: number; canceladas: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE c.estado = 'CANCELADA')::int AS canceladas
       FROM citas c
       WHERE c.empresa_id = $1 AND c.fecha BETWEEN $2::date AND $3::date
         AND ($4::varchar IS NULL OR c.barbero_id = $4)`,
      parametros(p),
    )
  ).rows[0];

// Clientes con alguna cita no cancelada en el rango: nuevos (sin citas no canceladas antes de
// "desde") y recurrentes (con alguna antes). Con barberoId, solo se miran las citas de ese profesional.
export const clientesNuevosYRecurrentes = async (db: Consultable, p: FiltroCartera) =>
  (
    await db.query<{ nuevos: number; recurrentes: number }>(
      `SELECT count(*) FILTER (WHERE NOT t.previo)::int AS nuevos, count(*) FILTER (WHERE t.previo)::int AS recurrentes
       FROM (
         SELECT e.cliente_id,
                EXISTS (SELECT 1 FROM citas a
                        WHERE a.empresa_id = $1 AND a.cliente_id = e.cliente_id AND a.estado <> 'CANCELADA'
                          AND a.fecha < $2::date AND ($4::varchar IS NULL OR a.barbero_id = $4)) AS previo
         FROM (SELECT DISTINCT c.cliente_id FROM citas c
               WHERE c.empresa_id = $1 AND c.estado <> 'CANCELADA' AND c.cliente_id IS NOT NULL
                 AND c.fecha BETWEEN $2::date AND $3::date AND ($4::varchar IS NULL OR c.barbero_id = $4)) e
       ) t`,
      parametros(p),
    )
  ).rows[0];
