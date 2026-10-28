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
  // null si el negocio no atiende ese día de la semana
  horario_apertura: string | null;
  horario_cierre: string | null;
  // Hoy y el último día que se puede reservar, en la zona horaria del negocio (AAAA-MM-DD)
  hoy: string;
  ultimo_dia: string;
  zona_horaria: string;
  // Intervalo de horarios del negocio, servicio activo más corto y hora actual en la zona del negocio
  intervalo_minutos: number;
  servicio_mas_corto: number;
  minutos_ahora: number;
};

// Las reservas van desde hoy hasta 14 días después (15 días contando hoy)
export const DIAS_RESERVA = 14;

// Servicio, profesional, horario de ese día y rango de fechas en una sola consulta.
// Solo devuelve fila si el servicio y el profesional pertenecen a ese negocio y
// el profesional atiende clientes.
export const buscarDatosReserva = async (
  db: Consultable,
  p: { empresaId: string; barberoId: string; servicioId: string; fecha: string },
) =>
  (
    await db.query<DatosReserva>(
      `SELECT s.nombre AS servicio, s.duracion_min, s.precio, b.nombre AS barbero,
              to_char(h.hora_apertura, 'HH24:MI') AS horario_apertura,
              to_char(h.hora_cierre, 'HH24:MI') AS horario_cierre,
              to_char(hoy.fecha, 'YYYY-MM-DD') AS hoy,
              to_char(hoy.fecha + $5::int, 'YYYY-MM-DD') AS ultimo_dia,
              e.intervalo_minutos, e.zona_horaria,
              (SELECT min(duracion_min) FROM servicios WHERE empresa_id = e.id AND activo)::int AS servicio_mas_corto,
              (EXTRACT(HOUR FROM hoy.ahora) * 60 + EXTRACT(MINUTE FROM hoy.ahora))::int AS minutos_ahora
       FROM empresas e
       JOIN servicios s ON s.empresa_id = e.id AND s.id = $2 AND s.activo
       JOIN barberos b ON b.empresa_id = e.id AND b.id = $3 AND b.activo AND b.atiende_clientes
       CROSS JOIN LATERAL (
         SELECT (now() AT TIME ZONE e.zona_horaria)::date AS fecha, (now() AT TIME ZONE e.zona_horaria)::time AS ahora
       ) hoy
       LEFT JOIN horarios_empresa h ON h.empresa_id = e.id AND h.dia_semana = EXTRACT(DOW FROM $4::date)
       WHERE e.id = $1`,
      [p.empresaId, p.servicioId, p.barberoId, p.fecha, DIAS_RESERVA],
    )
  ).rows[0];

// Crea el cliente o suma una cita al existente, sin carreras entre solicitudes.
// El teléfono (E.164) es único por negocio.
export const registrarCliente = async (
  db: Consultable,
  c: { id: string; empresaId: string; telefono: string; indicativo: string; nombre: string; fecha: string },
) =>
  (
    await db.query<{ id: string }>(
      `INSERT INTO clientes (id, empresa_id, telefono, indicativo, nombre, total_citas, fecha_ultima_cita)
       VALUES ($1, $2, $3, $4, $5, 1, $6)
       ON CONFLICT (empresa_id, telefono) DO UPDATE
         SET total_citas = clientes.total_citas + 1,
             -- Una reserva para una fecha anterior no hace retroceder la última cita
             fecha_ultima_cita = GREATEST(clientes.fecha_ultima_cita, EXCLUDED.fecha_ultima_cita)
       RETURNING id`,
      [c.id, c.empresaId, c.telefono, c.indicativo, c.nombre, c.fecha],
    )
  ).rows[0].id;

// Cliente de ese negocio (nunca de otro)
export const buscarClienteDelNegocio = async (db: Consultable, empresaId: string, clienteId: string) =>
  (
    await db.query<{ nombre: string; telefono: string; indicativo: string }>(
      'SELECT nombre, telefono, indicativo FROM clientes WHERE id = $1 AND empresa_id = $2',
      [clienteId, empresaId],
    )
  ).rows[0];

// Cuenta de cliente con ese teléfono (E.164), si la hay: las citas que el negocio agenda a su nombre aparecen en "Mis citas"
export const buscarCuentaDeClientePorTelefono = async (db: Consultable, telefono: string) =>
  (await db.query<{ id: string }>(`SELECT id FROM usuarios WHERE rol = 'cliente' AND telefono = $1`, [telefono])).rows[0]?.id ?? null;

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
    // Cuenta del cliente que reservó con su sesión; null = invitado
    usuarioId: string | null;
  },
) =>
  db.query(
    `INSERT INTO citas (id, empresa_id, barbero_id, servicio_id, cliente_id, fecha, hora_inicio, hora_fin, precio,
       estado, usuario_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CONFIRMADA', $10)`,
    [c.id, c.empresaId, c.barberoId, c.servicioId, c.clienteId, c.fecha, c.horaInicio, c.horaFin, c.precio, c.usuarioId],
  );

// Bloquea la fila del profesional hasta que termine la transacción: así las reservas de un
// mismo profesional se hacen de una en una (y también esperan a un bloqueo que se esté
// creando, que toma un bloqueo compartido sobre esa fila). false si ya no atiende clientes.
export const bloquearProfesional = async (db: Consultable, empresaId: string, barberoId: string) =>
  (
    await db.query(
      `SELECT 1 FROM barberos WHERE id = $1 AND empresa_id = $2 AND activo AND atiende_clientes FOR UPDATE`,
      [barberoId, empresaId],
    )
  ).rowCount! > 0;

// Las reservas de un mismo teléfono en un negocio se hacen de una en una (dura hasta el fin de la transacción):
// así dos reservas a la vez, con profesionales distintos, no pasan juntas el tope de citas pendientes
export const bloquearTelefono = (db: Consultable, empresaId: string, telefono: string) =>
  db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`citas-pendientes:${empresaId}:${telefono}`]);

// Citas pendientes de ese teléfono en el negocio: confirmadas y que aún no terminan (en la hora del negocio).
// Una cita confirmada que ya pasó sin marcarse como atendida no cuenta.
export const contarCitasPendientesDeTelefono = async (db: Consultable, empresaId: string, telefono: string) =>
  (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM citas c
       JOIN clientes cl ON cl.id = c.cliente_id AND cl.empresa_id = c.empresa_id
       JOIN empresas e ON e.id = c.empresa_id
       WHERE c.empresa_id = $1 AND cl.telefono = $2 AND c.estado = 'CONFIRMADA'
         AND (c.fecha + c.hora_fin) AT TIME ZONE e.zona_horaria > now()`,
      [empresaId, telefono],
    )
  ).rows[0].n;

// true si ya hay una cita (no cancelada) del profesional que se cruza con esas horas
// excluirCitaId: una cita que se está moviendo no choca consigo misma
export const chocaConCita = async (
  db: Consultable,
  p: { barberoId: string; fecha: string; horaInicio: string; horaFin: string; excluirCitaId?: string },
) =>
  (
    await db.query(
      `SELECT 1 FROM citas
       WHERE barbero_id = $1 AND fecha = $2::date AND estado <> 'CANCELADA'
         AND hora_inicio < $4::time AND hora_fin > $3::time
         AND ($5::varchar IS NULL OR id <> $5)
       LIMIT 1`,
      [p.barberoId, p.fecha, p.horaInicio, p.horaFin, p.excluirCitaId ?? null],
    )
  ).rowCount! > 0;

export type CitaDeCliente = {
  id: string;
  empresa_id: string;
  barbero_id: string;
  servicio_id: string;
  cliente_id: string;
  estado: string;
  fecha: string;
  hora_inicio: string;
  hora_fin: string;
  duracion_min: number;
  // Fecha (DD/MM/AAAA) y hora (12 h) para los textos de los avisos
  fecha_aviso: string;
  hora_aviso: string;
  anticipacion_horas: number;
  // La cita ya empezó / empieza dentro de menos de la anticipación mínima del negocio
  empezo: boolean;
  fuera_de_plazo: boolean;
};

// Una cita reservada con la cuenta del cliente, con lo necesario para aplicar la política de
// cancelación y reprogramación del negocio. bloquear = true la bloquea hasta terminar la transacción.
export const buscarCitaDeCliente = async (db: Consultable, citaId: string, usuarioId: string, bloquear = false) =>
  (
    await db.query<CitaDeCliente>(
      `SELECT c.id, c.empresa_id, c.barbero_id, c.servicio_id, c.cliente_id, c.estado,
              to_char(c.fecha, 'YYYY-MM-DD') AS fecha, to_char(c.hora_inicio, 'HH24:MI') AS hora_inicio,
              to_char(c.hora_fin, 'HH24:MI') AS hora_fin, ${DURACION} AS duracion_min,
              to_char(c.fecha, 'DD/MM/YYYY') AS fecha_aviso, to_char(c.hora_inicio, 'HH12:MI AM') AS hora_aviso,
              e.anticipacion_cancelacion_horas AS anticipacion_horas,
              inicio.instante <= now() AS empezo,
              inicio.instante <= now() + make_interval(hours => e.anticipacion_cancelacion_horas) AS fuera_de_plazo
       FROM citas c
       JOIN empresas e ON e.id = c.empresa_id
       CROSS JOIN LATERAL (SELECT (c.fecha + c.hora_inicio) AT TIME ZONE e.zona_horaria AS instante) inicio
       WHERE c.id = $1 AND c.usuario_id = $2
       ${bloquear ? 'FOR UPDATE OF c' : ''}`,
      [citaId, usuarioId],
    )
  ).rows[0];

// Cambia la fecha y la hora de la cita (conserva su duración y precio) y vuelve a habilitar su recordatorio
export const moverCita = (db: Consultable, p: { id: string; empresaId: string; fecha: string; horaInicio: string; horaFin: string }) =>
  db.query(
    `UPDATE citas SET fecha = $3, hora_inicio = $4, hora_fin = $5, recordatorio_enviado_en = NULL, recordatorio_2h_enviado_en = NULL
     WHERE id = $1 AND empresa_id = $2`,
    [p.id, p.empresaId, p.fecha, p.horaInicio, p.horaFin],
  );

// La última cita del cliente en el negocio no retrocede
export const avanzarUltimaCita = (db: Consultable, empresaId: string, clienteId: string, fecha: string) =>
  db.query('UPDATE clientes SET fecha_ultima_cita = GREATEST(fecha_ultima_cita, $3::date) WHERE id = $1 AND empresa_id = $2', [
    clienteId,
    empresaId,
    fecha,
  ]);

type Momento = { fecha: string; horaInicio: string; horaFin: string };

// Historial de cambios de fecha u hora de la cita
export const insertarReprogramacion = (db: Consultable, p: { citaId: string; usuarioId: string; anterior: Momento; nueva: Momento }) =>
  db.query(
    `INSERT INTO citas_reprogramaciones (cita_id, usuario_id, fecha_anterior, hora_inicio_anterior, hora_fin_anterior,
       fecha_nueva, hora_inicio_nueva, hora_fin_nueva)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      p.citaId,
      p.usuarioId,
      p.anterior.fecha,
      p.anterior.horaInicio,
      p.anterior.horaFin,
      p.nueva.fecha,
      p.nueva.horaInicio,
      p.nueva.horaFin,
    ],
  );

export type FilaReprogramacion = {
  id: string;
  fecha_anterior: string;
  hora_anterior: string;
  fecha_nueva: string;
  hora_nueva: string;
  creada_en: Date;
  zona_horaria: string;
};

// Cambios de una cita de ese cliente, del más antiguo al más reciente
export const listarReprogramaciones = async (db: Consultable, citaId: string, usuarioId: string) =>
  (
    await db.query<FilaReprogramacion>(
      `SELECT r.id, to_char(r.fecha_anterior, 'YYYY-MM-DD') AS fecha_anterior,
              to_char(r.hora_inicio_anterior, 'HH12:MI AM') AS hora_anterior,
              to_char(r.fecha_nueva, 'YYYY-MM-DD') AS fecha_nueva, to_char(r.hora_inicio_nueva, 'HH12:MI AM') AS hora_nueva,
              r.creada_en, e.zona_horaria
       FROM citas_reprogramaciones r
       JOIN citas c ON c.id = r.cita_id
       JOIN empresas e ON e.id = c.empresa_id
       WHERE r.cita_id = $1 AND c.usuario_id = $2
       ORDER BY r.creada_en, r.id`,
      [citaId, usuarioId],
    )
  ).rows;

// Lo que ocupa un profesional un día, en minutos desde la medianoche: sus citas no
// canceladas y sus bloqueos (semanales de ese día de la semana, o de esa fecha)
export const listarTramosOcupados = async (db: Consultable, p: { barberoId: string; fecha: string }) =>
  (
    await db.query<{ inicio: number; fin: number }>(
      `SELECT (EXTRACT(EPOCH FROM hora_inicio) / 60)::int AS inicio, (EXTRACT(EPOCH FROM hora_fin) / 60)::int AS fin
       FROM citas
       WHERE barbero_id = $1 AND fecha = $2::date AND estado <> 'CANCELADA'
       UNION ALL
       SELECT (EXTRACT(EPOCH FROM hora_inicio) / 60)::int, (EXTRACT(EPOCH FROM hora_fin) / 60)::int
       FROM bloqueos
       WHERE barbero_id = $1
         AND ((es_repetitivo AND dia_semana = EXTRACT(DOW FROM $2::date)) OR fecha_especifica = $2::date)`,
      [p.barberoId, p.fecha],
    )
  ).rows;

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

// Bloqueos del equipo activo, para que la app no ofrezca esas horas: semanales y
// de una fecha (de hoy en adelante, en la zona del negocio). Sin el motivo.
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
       WHERE bl.es_repetitivo OR bl.fecha_especifica >= (now() AT TIME ZONE (SELECT zona_horaria FROM empresas WHERE id = $1))::date
       ORDER BY bl.barbero_id, bl.dia_semana, bl.fecha_especifica, bl.hora_inicio`,
      [empresaId],
    )
  ).rows;

// Trae desde ayer (en la zona del negocio), para no perder las citas de hoy
export const listarOcupadas = async (db: Consultable, empresaId: string) =>
  (
    await db.query<{ barbero_id: string; estado: string; fecha: string; hora: string; duracion_min: number }>(
      `SELECT c.barbero_id, c.estado, ${FECHA} AS fecha, ${HORA} AS hora, ${DURACION} AS duracion_min
       FROM citas c
       WHERE c.empresa_id = $1 AND c.estado <> 'CANCELADA' AND c.fecha >= (now() AT TIME ZONE (SELECT zona_horaria FROM empresas WHERE id = $1))::date - 1`,
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
  zona_horaria: string;
  cliente: string;
  telefono: string;
  servicio: string;
  barbero_nombre: string;
  veces_reprogramada: number;
};

// barberoId null = todo el equipo del negocio
export const listarAgenda = async (db: Consultable, empresaId: string, barberoId: string | null) =>
  (
    await db.query<FilaAgenda>(
      `SELECT c.id, c.empresa_id, c.barbero_id, c.estado, c.precio,
              ${FECHA} AS fecha, ${HORA} AS hora, ${DURACION} AS duracion_min,
              ${QUIEN('bc', 'uc', 'e')} AS completada_por, c.completada_en,
              ${QUIEN('bx', 'ux', 'e')} AS cancelada_por, c.cancelada_en, e.zona_horaria,
              cl.nombre AS cliente, cl.telefono,
              s.nombre AS servicio, b.nombre AS barbero_nombre,
              (SELECT count(*)::int FROM citas_reprogramaciones r WHERE r.cita_id = c.id) AS veces_reprogramada
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
    await db.query<{ estado: string; completada_en: Date; completada_por: string; zona_horaria: string }>(
      `WITH actualizada AS (
         UPDATE citas
         SET estado = 'COMPLETADA', completada_en = NOW(), completada_por = $3, completada_por_usuario = $4,
             -- La cartera usa el porcentaje que el profesional tiene en este momento
             porcentaje_ganancia = (SELECT b.porcentaje_ganancia FROM barberos b WHERE b.id = citas.barbero_id)
         WHERE id = $1 AND empresa_id = $2 AND estado = 'CONFIRMADA'
           AND ($3::varchar IS NULL OR barbero_id = $3)
         RETURNING estado, completada_en, completada_por, completada_por_usuario, empresa_id
       )
       SELECT a.estado, a.completada_en, e.zona_horaria, ${QUIEN('b', 'u', 'e')} AS completada_por
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
    await db.query<{ estado: string; cancelada_en: Date; cancelada_por: string; zona_horaria: string }>(
      `WITH actualizada AS (
         UPDATE citas
         SET estado = 'CANCELADA', cancelada_en = NOW(), cancelada_por = $3, cancelada_por_usuario = $4
         WHERE id = $1 AND empresa_id = $2 AND estado = 'CONFIRMADA'
         RETURNING estado, cancelada_en, cancelada_por, cancelada_por_usuario, empresa_id
       )
       SELECT a.estado, a.cancelada_en, e.zona_horaria, ${QUIEN('b', 'u', 'e')} AS cancelada_por
       FROM actualizada a
       JOIN empresas e ON e.id = a.empresa_id
       LEFT JOIN barberos b ON b.id = a.cancelada_por
       LEFT JOIN usuarios u ON u.id = a.cancelada_por_usuario`,
      [p.id, p.empresaId, p.barberoId, p.usuarioId],
    )
  ).rows[0];

// ¿La cita es de este negocio? (cualquier estado)
export const existeCitaDelNegocio = async (db: Consultable, id: string, empresaId: string) =>
  (await db.query('SELECT 1 FROM citas WHERE id = $1 AND empresa_id = $2', [id, empresaId])).rowCount! > 0;
