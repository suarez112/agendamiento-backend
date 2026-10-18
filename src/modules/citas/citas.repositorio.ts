import type { Consultable } from '../../db/pool.js';

// Formatos de salida compartidos por la agenda y las horas ocupadas
const FECHA = `to_char(c.fecha, 'YYYY-MM-DD')`;
const HORA = `to_char(c.hora_inicio, 'HH12:MI AM')`;
const DURACION = `(EXTRACT(EPOCH FROM (c.hora_fin - c.hora_inicio)) / 60)::int`;

export type DatosReserva = {
  servicio: string;
  duracion_min: number;
  precio: string;
  barbero: string;
  horario_apertura: string;
  horario_cierre: string;
  fecha_vigente: boolean;
};

// Servicio, profesional y horario en una sola consulta. Solo devuelve fila si
// el servicio y el profesional pertenecen a ese negocio.
export const buscarDatosReserva = async (
  db: Consultable,
  p: { empresaId: string; barberoId: string; servicioId: string; fecha: string },
) =>
  (
    await db.query<DatosReserva>(
      `SELECT s.nombre AS servicio, s.duracion_min, s.precio, b.nombre AS barbero,
              e.horario_apertura, e.horario_cierre,
              $4::date >= CURRENT_DATE - 1 AS fecha_vigente
       FROM empresas e
       JOIN servicios s ON s.empresa_id = e.id AND s.id = $2
       JOIN barberos b ON b.empresa_id = e.id AND b.id = $3
       WHERE e.id = $1`,
      [p.empresaId, p.servicioId, p.barberoId, p.fecha],
    )
  ).rows[0];

// Crea el cliente o suma una cita al existente, sin carreras entre solicitudes
export const registrarCliente = async (
  db: Consultable,
  c: { id: string; empresaId: string; telefono: string; indicativo: string; nombre: string; fecha: string },
) =>
  (
    await db.query<{ id: string }>(
      `INSERT INTO clientes (id, empresa_id, telefono, indicativo, nombre, total_citas, fecha_ultima_cita)
       VALUES ($1, $2, $3, $4, $5, 1, $6)
       ON CONFLICT (empresa_id, indicativo, telefono) DO UPDATE
         SET total_citas = clientes.total_citas + 1,
             fecha_ultima_cita = EXCLUDED.fecha_ultima_cita
       RETURNING id`,
      [c.id, c.empresaId, c.telefono, c.indicativo, c.nombre, c.fecha],
    )
  ).rows[0].id;

export const insertarCita = (
  db: Consultable,
  c: {
    id: string;
    empresaId: string;
    barberoId: string;
    servicioId: string;
    clienteId: string;
    fecha: string;
    horaInicio: string;
    horaFin: string;
    precio: string;
  },
) =>
  db.query(
    `INSERT INTO citas (id, empresa_id, barbero_id, servicio_id, cliente_id, fecha, hora_inicio, hora_fin, precio, estado)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CONFIRMADA')`,
    [c.id, c.empresaId, c.barberoId, c.servicioId, c.clienteId, c.fecha, c.horaInicio, c.horaFin, c.precio],
  );

// "fecha >= CURRENT_DATE - 1" trae desde ayer, para no perder las citas de hoy
// si el reloj del servidor y el de tu país no coinciden
export const listarOcupadas = async (db: Consultable, empresaId: string) =>
  (
    await db.query<{ barbero_id: string; estado: string; fecha: string; hora: string; duracion_min: number }>(
      `SELECT c.barbero_id, c.estado, ${FECHA} AS fecha, ${HORA} AS hora, ${DURACION} AS duracion_min
       FROM citas c
       WHERE c.empresa_id = $1 AND c.estado <> 'CANCELADA' AND c.fecha >= CURRENT_DATE - 1`,
      [empresaId],
    )
  ).rows;

export type FilaAgenda = {
  id: string;
  empresa_id: string;
  barbero_id: string;
  estado: string;
  precio: string;
  fecha: string;
  hora: string;
  duracion_min: number;
  completada_por: string | null;
  completada_en: Date | null;
  cancelada_por: string | null;
  cancelada_en: Date | null;
  cliente: string;
  telefono: string;
  servicio: string;
  barbero_nombre: string;
};

// barberoId null = todo el equipo del negocio
export const listarAgenda = async (db: Consultable, empresaId: string, barberoId: string | null) =>
  (
    await db.query<FilaAgenda>(
      `SELECT c.id, c.empresa_id, c.barbero_id, c.estado, c.precio,
              ${FECHA} AS fecha, ${HORA} AS hora, ${DURACION} AS duracion_min,
              bc.nombre AS completada_por, c.completada_en,
              bx.nombre AS cancelada_por, c.cancelada_en,
              cl.nombre AS cliente, cl.telefono,
              s.nombre AS servicio, b.nombre AS barbero_nombre
       FROM citas c
       JOIN clientes cl ON cl.id = c.cliente_id
       JOIN servicios s ON s.id = c.servicio_id
       JOIN barberos b ON b.id = c.barbero_id
       LEFT JOIN barberos bc ON bc.id = c.completada_por
       LEFT JOIN barberos bx ON bx.id = c.cancelada_por
       WHERE c.empresa_id = $1 AND ($2::varchar IS NULL OR c.barbero_id = $2)
       ORDER BY c.fecha, c.hora_inicio`,
      [empresaId, barberoId],
    )
  ).rows;

// Solo el profesional dueño de la cita, y solo si sigue confirmada
export const completarCita = async (
  db: Consultable,
  p: { id: string; empresaId: string; barberoId: string },
) =>
  (
    await db.query<{ estado: string; completada_en: Date; completada_por: string }>(
      `WITH actualizada AS (
         UPDATE citas
         SET estado = 'COMPLETADA', completada_en = NOW(), completada_por = $3
         WHERE id = $1 AND empresa_id = $2 AND barbero_id = $3 AND estado = 'CONFIRMADA'
         RETURNING estado, completada_en, completada_por
       )
       SELECT a.estado, a.completada_en, b.nombre AS completada_por
       FROM actualizada a JOIN barberos b ON b.id = a.completada_por`,
      [p.id, p.empresaId, p.barberoId],
    )
  ).rows[0];

// Cualquier cita confirmada del negocio (el permiso de admin lo valida la ruta)
export const cancelarCita = async (
  db: Consultable,
  p: { id: string; empresaId: string; barberoId: string },
) =>
  (
    await db.query<{ estado: string; cancelada_en: Date; cancelada_por: string }>(
      `WITH actualizada AS (
         UPDATE citas
         SET estado = 'CANCELADA', cancelada_en = NOW(), cancelada_por = $3
         WHERE id = $1 AND empresa_id = $2 AND estado = 'CONFIRMADA'
         RETURNING estado, cancelada_en, cancelada_por
       )
       SELECT a.estado, a.cancelada_en, b.nombre AS cancelada_por
       FROM actualizada a JOIN barberos b ON b.id = a.cancelada_por`,
      [p.id, p.empresaId, p.barberoId],
    )
  ).rows[0];
