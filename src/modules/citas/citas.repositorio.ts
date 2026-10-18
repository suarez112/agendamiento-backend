import type { Consultable } from '../../db/pool.js';

// Formatos de salida compartidos por la agenda y las horas ocupadas
const FECHA = `to_char(c.fecha, 'YYYY-MM-DD')`;
const HORA = `to_char(c.hora_inicio, 'HH12:MI AM')`;
const DURACION = `(EXTRACT(EPOCH FROM (c.hora_fin - c.hora_inicio)) / 60)::int`;

// Nombre de quien completó o canceló: un barbero, o la cuenta del administrador
// (se muestra el nombre de la administradora del negocio, o su correo)
const QUIEN = (barbero: string, usuario: string, empresa: string) =>
  `CASE WHEN ${barbero}.id IS NOT NULL THEN ${barbero}.nombre
        WHEN ${usuario}.id IS NOT NULL THEN COALESCE(${empresa}.nombre_administradora, ${usuario}.correo) END`;

// Quién hace el cambio: exactamente uno de los dos viene lleno
type Autor = { barberoId: string | null; usuarioId: string | null };

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
       JOIN servicios s ON s.empresa_id = e.id AND s.id = $2 AND s.activo
       JOIN barberos b ON b.empresa_id = e.id AND b.id = $3 AND b.activo
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

// true si el teléfono está en la lista negra del negocio. Compara solo los
// dígitos: "300 123-4567" y "3001234567" son el mismo número.
export const telefonoEnListaNegra = async (db: Consultable, empresaId: string, telefono: string) =>
  (
    await db.query(
      `SELECT 1 FROM lista_negra
       WHERE empresa_id = $1
         AND regexp_replace(telefono, '[^0-9]', '', 'g') = regexp_replace($2, '[^0-9]', '', 'g')
       LIMIT 1`,
      [empresaId, telefono],
    )
  ).rowCount! > 0;

// true si la hora pedida cae dentro de un bloqueo del profesional: semanal
// (mismo día de la semana) o de esa fecha exacta
export const chocaConBloqueo = async (
  db: Consultable,
  p: { barberoId: string; fecha: string; horaInicio: string; horaFin: string },
) =>
  (
    await db.query(
      `SELECT 1 FROM bloqueos
       WHERE barbero_id = $1 AND hora_inicio < $4::time AND hora_fin > $3::time
         AND ((es_repetitivo AND dia_semana = EXTRACT(DOW FROM $2::date)) OR fecha_especifica = $2::date)
       LIMIT 1`,
      [p.barberoId, p.fecha, p.horaInicio, p.horaFin],
    )
  ).rowCount! > 0;

// Bloqueos del equipo activo, para que la app no ofrezca esas horas. Sin el motivo.
export const listarBloqueosPublicos = async (db: Consultable, empresaId: string) =>
  (
    await db.query<{
      barbero_id: string;
      dia_semana: number | null;
      fecha: string | null;
      hora_inicio: string;
      hora_fin: string;
    }>(
      `SELECT bl.barbero_id, CASE WHEN bl.es_repetitivo THEN bl.dia_semana END AS dia_semana,
              to_char(bl.fecha_especifica, 'YYYY-MM-DD') AS fecha,
              to_char(bl.hora_inicio, 'HH24:MI') AS hora_inicio, to_char(bl.hora_fin, 'HH24:MI') AS hora_fin
       FROM bloqueos bl
       JOIN barberos b ON b.id = bl.barbero_id AND b.empresa_id = $1 AND b.activo
       WHERE (bl.es_repetitivo AND bl.dia_semana IS NOT NULL) OR bl.fecha_especifica >= CURRENT_DATE - 1
       ORDER BY bl.barbero_id, bl.dia_semana, bl.fecha_especifica, bl.hora_inicio`,
      [empresaId],
    )
  ).rows;

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
              ${QUIEN('bc', 'uc', 'e')} AS completada_por, c.completada_en,
              ${QUIEN('bx', 'ux', 'e')} AS cancelada_por, c.cancelada_en,
              cl.nombre AS cliente, cl.telefono,
              s.nombre AS servicio, b.nombre AS barbero_nombre
       FROM citas c
       JOIN empresas e ON e.id = c.empresa_id
       JOIN clientes cl ON cl.id = c.cliente_id
       JOIN servicios s ON s.id = c.servicio_id
       JOIN barberos b ON b.id = c.barbero_id
       LEFT JOIN barberos bc ON bc.id = c.completada_por
       LEFT JOIN barberos bx ON bx.id = c.cancelada_por
       LEFT JOIN usuarios uc ON uc.id = c.completada_por_usuario
       LEFT JOIN usuarios ux ON ux.id = c.cancelada_por_usuario
       WHERE c.empresa_id = $1 AND ($2::varchar IS NULL OR c.barbero_id = $2)
       ORDER BY c.fecha, c.hora_inicio`,
      [empresaId, barberoId],
    )
  ).rows;

// Un barbero solo completa sus propias citas; la cuenta del administrador,
// cualquier cita del negocio. En ambos casos solo si sigue confirmada.
export const completarCita = async (db: Consultable, p: { id: string; empresaId: string } & Autor) =>
  (
    await db.query<{ estado: string; completada_en: Date; completada_por: string }>(
      `WITH actualizada AS (
         UPDATE citas
         SET estado = 'COMPLETADA', completada_en = NOW(), completada_por = $3, completada_por_usuario = $4,
             -- La cartera usa el porcentaje que el profesional tiene en este momento
             porcentaje_ganancia = (SELECT b.porcentaje_ganancia FROM barberos b WHERE b.id = citas.barbero_id)
         WHERE id = $1 AND empresa_id = $2 AND estado = 'CONFIRMADA'
           AND ($3::varchar IS NULL OR barbero_id = $3)
         RETURNING estado, completada_en, completada_por, completada_por_usuario, empresa_id
       )
       SELECT a.estado, a.completada_en, ${QUIEN('b', 'u', 'e')} AS completada_por
       FROM actualizada a
       JOIN empresas e ON e.id = a.empresa_id
       LEFT JOIN barberos b ON b.id = a.completada_por
       LEFT JOIN usuarios u ON u.id = a.completada_por_usuario`,
      [p.id, p.empresaId, p.barberoId, p.usuarioId],
    )
  ).rows[0];

// Cualquier cita confirmada del negocio (el permiso de admin lo valida la ruta)
export const cancelarCita = async (db: Consultable, p: { id: string; empresaId: string } & Autor) =>
  (
    await db.query<{ estado: string; cancelada_en: Date; cancelada_por: string }>(
      `WITH actualizada AS (
         UPDATE citas
         SET estado = 'CANCELADA', cancelada_en = NOW(), cancelada_por = $3, cancelada_por_usuario = $4
         WHERE id = $1 AND empresa_id = $2 AND estado = 'CONFIRMADA'
         RETURNING estado, cancelada_en, cancelada_por, cancelada_por_usuario, empresa_id
       )
       SELECT a.estado, a.cancelada_en, ${QUIEN('b', 'u', 'e')} AS cancelada_por
       FROM actualizada a
       JOIN empresas e ON e.id = a.empresa_id
       LEFT JOIN barberos b ON b.id = a.cancelada_por
       LEFT JOIN usuarios u ON u.id = a.cancelada_por_usuario`,
      [p.id, p.empresaId, p.barberoId, p.usuarioId],
    )
  ).rows[0];
