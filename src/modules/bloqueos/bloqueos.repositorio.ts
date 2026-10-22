import type { Consultable } from '../../db/pool.js';

export type FilaBloqueo = {
  id: string;
  barbero_id: string;
  barbero_nombre: string;
  // Semanal: dia_semana lleno y fecha null. Solo ese día: fecha llena y dia_semana null.
  dia_semana: number | null;
  fecha: string | null;
  hora_inicio: string;
  hora_fin: string;
  motivo: string | null;
};

// Hoy en Colombia: los bloqueos de días que ya pasaron no se muestran
export const HOY_COLOMBIA = `(now() AT TIME ZONE 'America/Bogota')::date`;

// Formato de salida; un día completo sale de "00:00" a "24:00"
const SALIDA = (t: string) => `${t}.id, ${t}.barbero_id, ${t}.dia_semana,
  to_char(${t}.fecha_especifica, 'YYYY-MM-DD') AS fecha,
  to_char(${t}.hora_inicio, 'HH24:MI') AS hora_inicio, to_char(${t}.hora_fin, 'HH24:MI') AS hora_fin,
  ${t}.motivo`;

// Bloqueos semanales y de una fecha (de hoy en adelante) del equipo activo.
// La empresa se comprueba a través del barbero: la tabla bloqueos no la guarda.
// barberoId null = todo el equipo del negocio.
export const listarBloqueos = async (db: Consultable, empresaId: string, barberoId: string | null) =>
  (
    await db.query<FilaBloqueo>(
      `SELECT ${SALIDA('bl')}, b.nombre AS barbero_nombre
       FROM bloqueos bl
       JOIN barberos b ON b.id = bl.barbero_id AND b.empresa_id = $1 AND b.activo
       WHERE (bl.es_repetitivo OR bl.fecha_especifica >= ${HOY_COLOMBIA})
         AND ($2::varchar IS NULL OR bl.barbero_id = $2)
       ORDER BY b.nombre, bl.es_repetitivo DESC, bl.dia_semana, bl.fecha_especifica, bl.hora_inicio`,
      [empresaId, barberoId],
    )
  ).rows;

// Crea el bloqueo solo si el barbero es del negocio y está activo; undefined si no.
// Con diaSemana es semanal; con fecha, solo para ese día.
export const crearBloqueo = async (
  db: Consultable,
  p: {
    empresaId: string;
    barberoId: string;
    diaSemana: number | null;
    fecha: string | null;
    horaInicio: string;
    horaFin: string;
    motivo: string | null;
  },
) =>
  (
    await db.query<FilaBloqueo>(
      `WITH nuevo AS (
         INSERT INTO bloqueos (barbero_id, dia_semana, fecha_especifica, hora_inicio, hora_fin, es_repetitivo, motivo)
         SELECT b.id, $3::int, $4::date, $5::time, $6::time, $3::int IS NOT NULL, $7::varchar
         FROM barberos b WHERE b.id = $2 AND b.empresa_id = $1 AND b.activo
         RETURNING id, barbero_id, dia_semana, fecha_especifica, hora_inicio, hora_fin, motivo
       )
       SELECT ${SALIDA('n')}, b.nombre AS barbero_nombre
       FROM nuevo n JOIN barberos b ON b.id = n.barbero_id`,
      [p.empresaId, p.barberoId, p.diaSemana, p.fecha, p.horaInicio, p.horaFin, p.motivo],
    )
  ).rows[0];

// Borra un bloqueo del negocio
export const borrarBloqueo = async (db: Consultable, id: string, empresaId: string) =>
  (
    (
      await db.query(
        `DELETE FROM bloqueos bl USING barberos b
         WHERE bl.id = $1 AND b.id = bl.barbero_id AND b.empresa_id = $2`,
        [id, empresaId],
      )
    ).rowCount ?? 0
  ) > 0;

// Bloquea la fila del profesional (activo, del negocio) mientras dura la transacción: así una
// reserva y un bloqueo del mismo profesional se hacen de una en una. false si no existe.
export const bloquearProfesional = async (db: Consultable, empresaId: string, barberoId: string) =>
  (
    await db.query('SELECT 1 FROM barberos WHERE id = $1 AND empresa_id = $2 AND activo FOR UPDATE', [
      barberoId,
      empresaId,
    ])
  ).rowCount! > 0;

// true si hay una cita pendiente (CONFIRMADA) o completada que se cruza con el bloqueo.
// Un bloqueo semanal mira las citas de hoy en adelante que caen en ese día de la semana.
export const hayCitaEnHorario = async (
  db: Consultable,
  p: { barberoId: string; diaSemana: number | null; fecha: string | null; horaInicio: string; horaFin: string },
) =>
  (
    await db.query(
      `SELECT 1 FROM citas
       WHERE barbero_id = $1 AND estado IN ('CONFIRMADA', 'COMPLETADA')
         AND hora_inicio < $5::time AND hora_fin > $4::time
         AND (CASE WHEN $2::int IS NOT NULL
                   THEN fecha >= ${HOY_COLOMBIA} AND EXTRACT(DOW FROM fecha) = $2::int
                   ELSE fecha = $3::date END)
       LIMIT 1`,
      [p.barberoId, p.diaSemana, p.fecha, p.horaInicio, p.horaFin],
    )
  ).rowCount! > 0;

export const intervaloDelNegocio = async (db: Consultable, empresaId: string) =>
  (await db.query<{ intervalo_minutos: number }>('SELECT intervalo_minutos FROM empresas WHERE id = $1', [empresaId]))
    .rows[0]?.intervalo_minutos ?? 30;

export type FilaCitaRango = {
  id: string;
  barbero_id: string;
  barbero_nombre: string;
  fecha: string;
  hora_inicio: string;
  hora_fin: string;
  servicio: string;
  cliente: string;
  estado: string;
};

// Citas no canceladas del negocio entre dos fechas (incluidas), con su inicio y fin reales
export const listarCitasEnRango = async (
  db: Consultable,
  p: { empresaId: string; desde: string; hasta: string; barberoId: string | null },
) =>
  (
    await db.query<FilaCitaRango>(
      `SELECT c.id, c.barbero_id, b.nombre AS barbero_nombre, to_char(c.fecha, 'YYYY-MM-DD') AS fecha,
              to_char(c.hora_inicio, 'HH24:MI') AS hora_inicio, to_char(c.hora_fin, 'HH24:MI') AS hora_fin,
              s.nombre AS servicio, cl.nombre AS cliente, c.estado
       FROM citas c
       JOIN barberos b ON b.id = c.barbero_id
       JOIN servicios s ON s.id = c.servicio_id
       JOIN clientes cl ON cl.id = c.cliente_id
       WHERE c.empresa_id = $1 AND c.estado <> 'CANCELADA' AND c.fecha BETWEEN $2::date AND $3::date
         AND ($4::varchar IS NULL OR c.barbero_id = $4)
       ORDER BY c.fecha, c.hora_inicio`,
      [p.empresaId, p.desde, p.hasta, p.barberoId],
    )
  ).rows;

// Bloqueos que afectan al rango: los semanales y los de una fecha dentro del rango
export const listarBloqueosEnRango = async (
  db: Consultable,
  p: { empresaId: string; desde: string; hasta: string; barberoId: string | null },
) =>
  (
    await db.query<FilaBloqueo>(
      `SELECT ${SALIDA('bl')}, b.nombre AS barbero_nombre
       FROM bloqueos bl
       JOIN barberos b ON b.id = bl.barbero_id AND b.empresa_id = $1 AND b.activo
       WHERE (bl.es_repetitivo OR bl.fecha_especifica BETWEEN $2::date AND $3::date)
         AND ($4::varchar IS NULL OR bl.barbero_id = $4)
       ORDER BY b.nombre, bl.es_repetitivo DESC, bl.dia_semana, bl.fecha_especifica, bl.hora_inicio`,
      [p.empresaId, p.desde, p.hasta, p.barberoId],
    )
  ).rows;
