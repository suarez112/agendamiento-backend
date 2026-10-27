import type { Consultable } from '../../db/pool.js';

type Filtro = { empresaId: string; desde: string; hasta: string; barberoId: string | null };
const parametros = (p: Filtro) => [p.empresaId, p.desde, p.hasta, p.barberoId];

// Horario del negocio por día de la semana (un día sin fila = cerrado)
export const horarios = async (db: Consultable, empresaId: string) =>
  (
    await db.query<{ dia: number; inicio: number; fin: number }>(
      `SELECT dia_semana::int AS dia, (EXTRACT(EPOCH FROM hora_apertura) / 60)::int AS inicio,
              (EXTRACT(EPOCH FROM hora_cierre) / 60)::int AS fin
       FROM horarios_empresa WHERE empresa_id = $1`,
      [empresaId],
    )
  ).rows;

// Profesionales que hoy reciben reservas (activos y que atienden clientes)
export const profesionales = async (db: Consultable, empresaId: string, barberoId: string | null) =>
  (
    await db.query<{ id: string; nombre: string }>(
      `SELECT id, nombre FROM barberos
       WHERE empresa_id = $1 AND activo AND atiende_clientes AND ($2::varchar IS NULL OR id = $2)
       ORDER BY nombre`,
      [empresaId, barberoId],
    )
  ).rows;

// Bloqueos semanales y los de fechas dentro del rango, de esos profesionales
export const bloqueos = async (db: Consultable, p: Filtro) =>
  (
    await db.query<{ barbero_id: string; dia_semana: number | null; fecha: string | null; inicio: number; fin: number }>(
      `SELECT bl.barbero_id, CASE WHEN bl.es_repetitivo THEN bl.dia_semana END AS dia_semana,
              CASE WHEN NOT bl.es_repetitivo THEN to_char(bl.fecha_especifica, 'YYYY-MM-DD') END AS fecha,
              (EXTRACT(EPOCH FROM bl.hora_inicio) / 60)::int AS inicio, (EXTRACT(EPOCH FROM bl.hora_fin) / 60)::int AS fin
       FROM bloqueos bl
       JOIN barberos b ON b.id = bl.barbero_id AND b.empresa_id = $1 AND b.activo AND b.atiende_clientes
       WHERE ($4::varchar IS NULL OR bl.barbero_id = $4)
         AND (bl.es_repetitivo OR bl.fecha_especifica BETWEEN $2::date AND $3::date)`,
      parametros(p),
    )
  ).rows;

// Minutos con citas (no canceladas) de cada profesional en el rango
export const minutosOcupados = async (db: Consultable, p: Filtro) =>
  (
    await db.query<{ barbero_id: string; minutos: number }>(
      `SELECT c.barbero_id, (sum(EXTRACT(EPOCH FROM (c.hora_fin - c.hora_inicio))) / 60)::int AS minutos
       FROM citas c
       WHERE c.empresa_id = $1 AND c.estado <> 'CANCELADA' AND c.fecha BETWEEN $2::date AND $3::date
         AND ($4::varchar IS NULL OR c.barbero_id = $4)
       GROUP BY c.barbero_id`,
      parametros(p),
    )
  ).rows;

// Citas completadas por servicio: ingresos y minutos trabajados (la duración de cada cita)
export const serviciosRentables = async (db: Consultable, p: Filtro) =>
  (
    await db.query<{ servicio_id: string | null; nombre: string; citas: number; ingresos: string; minutos: number }>(
      `SELECT c.servicio_id, coalesce(s.nombre, 'Servicio eliminado') AS nombre, count(*)::int AS citas,
              sum(c.precio) AS ingresos,
              (sum(EXTRACT(EPOCH FROM (c.hora_fin - c.hora_inicio))) / 60)::int AS minutos
       FROM citas c LEFT JOIN servicios s ON s.id = c.servicio_id
       WHERE c.empresa_id = $1 AND c.estado = 'COMPLETADA' AND c.fecha BETWEEN $2::date AND $3::date
         AND ($4::varchar IS NULL OR c.barbero_id = $4)
       GROUP BY c.servicio_id, s.nombre`,
      parametros(p),
    )
  ).rows;

// Citas no canceladas por día de la semana (0 = domingo) y hora de inicio
export const demanda = async (db: Consultable, p: Filtro) =>
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

// Clientes con citas completadas en el rango: cuánto gastaron y cuántas veces vinieron
export const clientesDelPeriodo = async (db: Consultable, p: Filtro) =>
  (
    await db.query<{ cliente_id: string; nombre: string; visitas: number; gasto: string; ultima_visita: string }>(
      `SELECT c.cliente_id, cl.nombre, count(*)::int AS visitas, sum(c.precio) AS gasto,
              to_char(max(c.fecha), 'YYYY-MM-DD') AS ultima_visita
       FROM citas c JOIN clientes cl ON cl.id = c.cliente_id
       WHERE c.empresa_id = $1 AND c.estado = 'COMPLETADA' AND c.fecha BETWEEN $2::date AND $3::date
         AND ($4::varchar IS NULL OR c.barbero_id = $4)
       GROUP BY c.cliente_id, cl.nombre`,
      parametros(p),
    )
  ).rows;

// Clientes que vinieron en el rango según cuántas citas completadas llevan en total hasta el fin del rango
export const retencionDeClientes = async (db: Consultable, p: Filtro) =>
  (
    await db.query<{ volvieron: number; una_vez: number }>(
      `WITH del_periodo AS (
         SELECT DISTINCT c.cliente_id FROM citas c
         WHERE c.empresa_id = $1 AND c.estado = 'COMPLETADA' AND c.fecha BETWEEN $2::date AND $3::date
           AND ($4::varchar IS NULL OR c.barbero_id = $4)
       ),
       totales AS (
         SELECT d.cliente_id, count(*) AS citas
         FROM del_periodo d
         JOIN citas c ON c.cliente_id = d.cliente_id AND c.empresa_id = $1 AND c.estado = 'COMPLETADA'
                     AND c.fecha <= $3::date AND ($4::varchar IS NULL OR c.barbero_id = $4)
         GROUP BY d.cliente_id
       )
       SELECT count(*) FILTER (WHERE citas >= 2)::int AS volvieron, count(*) FILTER (WHERE citas = 1)::int AS una_vez
       FROM totales`,
      parametros(p),
    )
  ).rows[0];

// Ventas y citas de cada mes del rango (todos los meses, aunque no tengan citas)
export const tendenciaMensual = async (db: Consultable, p: Filtro) =>
  (
    await db.query<{ mes: string; ventas: string; citas: number; completadas: number; canceladas: number }>(
      `SELECT to_char(m.mes, 'YYYY-MM') AS mes,
              coalesce(sum(c.precio) FILTER (WHERE c.estado = 'COMPLETADA'), 0) AS ventas,
              count(c.id) FILTER (WHERE c.estado <> 'CANCELADA')::int AS citas,
              count(c.id) FILTER (WHERE c.estado = 'COMPLETADA')::int AS completadas,
              count(c.id) FILTER (WHERE c.estado = 'CANCELADA')::int AS canceladas
       FROM generate_series(date_trunc('month', $2::date), date_trunc('month', $3::date), interval '1 month') AS m(mes)
       LEFT JOIN citas c ON c.empresa_id = $1 AND date_trunc('month', c.fecha) = m.mes
                        AND c.fecha BETWEEN $2::date AND $3::date AND ($4::varchar IS NULL OR c.barbero_id = $4)
       GROUP BY m.mes ORDER BY m.mes`,
      parametros(p),
    )
  ).rows;
