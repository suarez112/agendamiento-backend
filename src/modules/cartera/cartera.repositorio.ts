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
// La ganancia del profesional usa su porcentaje actual. Incluye a quienes ya
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
              round(sum(c.precio) * b.porcentaje_ganancia / 100, 2) AS ganancia
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
