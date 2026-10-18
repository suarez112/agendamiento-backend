import type { Consultable } from '../../db/pool.js';

export type FilaBloqueo = {
  id: string;
  barbero_id: string;
  barbero_nombre: string;
  dia_semana: number;
  hora_inicio: string;
  hora_fin: string;
  motivo: string | null;
};

// Bloqueos semanales (se repiten cada semana el mismo día) del equipo activo.
// La empresa se comprueba a través del barbero: la tabla bloqueos no la guarda.
// barberoId null = todo el equipo del negocio.
export const listarBloqueos = async (db: Consultable, empresaId: string, barberoId: string | null) =>
  (
    await db.query<FilaBloqueo>(
      `SELECT bl.id, bl.barbero_id, b.nombre AS barbero_nombre, bl.dia_semana,
              to_char(bl.hora_inicio, 'HH24:MI') AS hora_inicio, to_char(bl.hora_fin, 'HH24:MI') AS hora_fin,
              bl.motivo
       FROM bloqueos bl
       JOIN barberos b ON b.id = bl.barbero_id AND b.empresa_id = $1 AND b.activo
       WHERE bl.es_repetitivo AND bl.dia_semana IS NOT NULL
         AND ($2::varchar IS NULL OR bl.barbero_id = $2)
       ORDER BY b.nombre, bl.dia_semana, bl.hora_inicio`,
      [empresaId, barberoId],
    )
  ).rows;

// Crea el bloqueo solo si el barbero es del negocio y está activo; undefined si no
export const crearBloqueo = async (
  db: Consultable,
  p: { empresaId: string; barberoId: string; diaSemana: number; horaInicio: string; horaFin: string; motivo: string | null },
) =>
  (
    await db.query<FilaBloqueo>(
      `WITH nuevo AS (
         INSERT INTO bloqueos (barbero_id, dia_semana, hora_inicio, hora_fin, es_repetitivo, motivo)
         SELECT b.id, $3::int, $4::time, $5::time, true, $6::varchar
         FROM barberos b WHERE b.id = $2 AND b.empresa_id = $1 AND b.activo
         RETURNING id, barbero_id, dia_semana, hora_inicio, hora_fin, motivo
       )
       SELECT n.id, n.barbero_id, b.nombre AS barbero_nombre, n.dia_semana,
              to_char(n.hora_inicio, 'HH24:MI') AS hora_inicio, to_char(n.hora_fin, 'HH24:MI') AS hora_fin,
              n.motivo
       FROM nuevo n JOIN barberos b ON b.id = n.barbero_id`,
      [p.empresaId, p.barberoId, p.diaSemana, p.horaInicio, p.horaFin, p.motivo],
    )
  ).rows[0];

// Borra un bloqueo del negocio. barberoId != null limita a los bloqueos de ese barbero.
export const borrarBloqueo = async (db: Consultable, id: string, empresaId: string, barberoId: string | null) =>
  (
    (
      await db.query(
        `DELETE FROM bloqueos bl USING barberos b
         WHERE bl.id = $1 AND b.id = bl.barbero_id AND b.empresa_id = $2
           AND ($3::varchar IS NULL OR bl.barbero_id = $3)`,
        [id, empresaId, barberoId],
      )
    ).rowCount ?? 0
  ) > 0;
