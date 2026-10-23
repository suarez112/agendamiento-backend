import type { Consultable } from '../../db/pool.js';

export type FilaNegocioGuardado = {
  id: string;
  nombre: string;
  codigo_acceso: string;
  categoria: string | null;
  direccion: string | null;
  departamento: string | null;
  ciudad: string | null;
  logo_url: string | null;
  foto_url: string | null;
  guardado_en: Date;
  zona_horaria: string;
};

const COLUMNAS_NEGOCIO = `e.id, e.nombre, e.codigo_acceso, e.categoria, e.direccion, e.departamento, e.ciudad,
                          e.logo_url, e.foto_url, g.guardado_en, e.zona_horaria`;

// Negocios guardados por el cliente, del más reciente al más antiguo
export const listarNegociosGuardados = async (db: Consultable, usuarioId: string) =>
  (
    await db.query<FilaNegocioGuardado>(
      `SELECT ${COLUMNAS_NEGOCIO}
       FROM negocios_guardados g JOIN empresas e ON e.id = g.empresa_id
       WHERE g.usuario_id = $1
       ORDER BY g.guardado_en DESC`,
      [usuarioId],
    )
  ).rows;

// Guarda el negocio con ese código (si ya estaba, no cambia nada). undefined si el código no existe.
export const guardarNegocio = async (db: Consultable, usuarioId: string, codigo: string) =>
  (
    await db.query<FilaNegocioGuardado>(
      `WITH empresa AS (SELECT id FROM empresas WHERE codigo_acceso = $2),
       nuevo AS (
         INSERT INTO negocios_guardados (usuario_id, empresa_id)
         SELECT $1, id FROM empresa
         ON CONFLICT (usuario_id, empresa_id) DO NOTHING
         RETURNING empresa_id, guardado_en
       )
       SELECT ${COLUMNAS_NEGOCIO}
       FROM empresa
       JOIN empresas e ON e.id = empresa.id
       JOIN (
         SELECT empresa_id, guardado_en FROM nuevo
         UNION ALL
         SELECT empresa_id, guardado_en FROM negocios_guardados WHERE usuario_id = $1
       ) g ON g.empresa_id = e.id
       LIMIT 1`,
      [usuarioId, codigo],
    )
  ).rows[0];

export const quitarNegocio = async (db: Consultable, usuarioId: string, empresaId: string) =>
  (await db.query('DELETE FROM negocios_guardados WHERE usuario_id = $1 AND empresa_id = $2', [usuarioId, empresaId]))
    .rowCount! > 0;

export type FilaCitaCliente = {
  id: string;
  empresa_id: string;
  negocio: string;
  codigo_acceso: string;
  servicio: string;
  barbero_id: string;
  barbero_nombre: string;
  fecha: string;
  hora: string;
  duracion_min: number;
  precio: string;
  estado: string;
  zona_horaria: string;
};

// Citas que el cliente reservó con su sesión, de la más reciente a la más antigua
export const listarCitasCliente = async (db: Consultable, usuarioId: string) =>
  (
    await db.query<FilaCitaCliente>(
      `SELECT c.id, c.empresa_id, e.nombre AS negocio, e.codigo_acceso, s.nombre AS servicio,
              c.barbero_id, b.nombre AS barbero_nombre,
              to_char(c.fecha, 'YYYY-MM-DD') AS fecha, to_char(c.hora_inicio, 'HH12:MI AM') AS hora,
              (EXTRACT(EPOCH FROM (c.hora_fin - c.hora_inicio)) / 60)::int AS duracion_min,
              c.precio, c.estado, e.zona_horaria
       FROM citas c
       JOIN empresas e ON e.id = c.empresa_id
       JOIN servicios s ON s.id = c.servicio_id
       JOIN barberos b ON b.id = c.barbero_id
       WHERE c.usuario_id = $1
       ORDER BY c.fecha DESC, c.hora_inicio DESC`,
      [usuarioId],
    )
  ).rows;

// El cliente cancela una cita suya que sigue confirmada y todavía no empezó (en la zona del negocio).
// No se llena cancelada_por: la agenda mostraría a la administradora como quien canceló.
export const cancelarCitaCliente = async (db: Consultable, p: { id: string; usuarioId: string }) =>
  (
    await db.query<{ estado: string; cancelada_en: Date; zona_horaria: string }>(
      `UPDATE citas SET estado = 'CANCELADA', cancelada_en = NOW()
       WHERE id = $1 AND usuario_id = $2 AND estado = 'CONFIRMADA'
         AND (fecha + hora_inicio) AT TIME ZONE (SELECT zona_horaria FROM empresas WHERE id = citas.empresa_id) > now()
       RETURNING estado, cancelada_en, (SELECT zona_horaria FROM empresas WHERE id = citas.empresa_id) AS zona_horaria`,
      [p.id, p.usuarioId],
    )
  ).rows[0];
