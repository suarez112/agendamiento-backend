import type { Consultable } from '../../db/pool.js';

// Dueño de un dispositivo: un integrante del equipo o una cuenta (nunca los dos)
export type Titular = { usuarioId: string | null; barberoId: string | null };

// Si el token ya existía (otra persona inició sesión en ese celular), cambia de dueño
export const guardarDispositivo = (db: Consultable, d: Titular & { token: string; plataforma: string | null }) =>
  db.query(
    `INSERT INTO dispositivos_push (token, usuario_id, barbero_id, plataforma)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE
       SET usuario_id = EXCLUDED.usuario_id, barbero_id = EXCLUDED.barbero_id,
           plataforma = EXCLUDED.plataforma, actualizado_en = now()`,
    [d.token, d.usuarioId, d.barberoId, d.plataforma],
  );

// Solo borra el token si es de quien lo pide
export const borrarDispositivo = (db: Consultable, d: Titular & { token: string }) =>
  db.query(
    `DELETE FROM dispositivos_push
     WHERE token = $1 AND usuario_id IS NOT DISTINCT FROM $2::varchar AND barbero_id IS NOT DISTINCT FROM $3::varchar`,
    [d.token, d.usuarioId, d.barberoId],
  );

// Tokens que Expo dijo que ya no existen
export const borrarTokens = (db: Consultable, tokens: string[]) =>
  db.query('DELETE FROM dispositivos_push WHERE token = ANY($1::varchar[])', [tokens]);

export const tokensDeUsuarios = async (db: Consultable, usuarioIds: string[]) =>
  (
    await db.query<{ usuario_id: string; token: string }>(
      'SELECT usuario_id, token FROM dispositivos_push WHERE usuario_id = ANY($1::varchar[])',
      [usuarioIds],
    )
  ).rows;

// Celulares del profesional de la cita y de quienes administran el negocio: integrantes
// activos con rol Administrador y cuentas admin de la empresa
export const tokensDelNegocio = async (db: Consultable, p: { empresaId: string; barberoId: string }) =>
  (
    await db.query<{ token: string }>(
      `SELECT d.token FROM dispositivos_push d
       WHERE d.barbero_id IN (
               SELECT b.id FROM barberos b
               WHERE b.empresa_id = $1 AND b.activo AND (b.id = $2 OR b.es_admin))
          OR d.usuario_id IN (SELECT u.id FROM usuarios u WHERE u.empresa_id = $1 AND u.rol = 'admin')`,
      [p.empresaId, p.barberoId],
    )
  ).rows.map((f) => f.token);

export type DatosAviso = {
  id: string;
  empresa_id: string;
  barbero_id: string;
  usuario_id: string | null;
  cliente: string;
  servicio: string;
  negocio: string;
  fecha: string;
  hora: string;
};

// Texto de una cita para armar el aviso (fecha DD/MM/AAAA, hora 12 h)
const FECHA_AVISO = `to_char(c.fecha, 'DD/MM/YYYY')`;
const HORA_AVISO = `to_char(c.hora_inicio, 'HH12:MI AM')`;

export const datosAviso = async (db: Consultable, citaId: string) =>
  (
    await db.query<DatosAviso>(
      `SELECT c.id, c.empresa_id, c.barbero_id, c.usuario_id, cl.nombre AS cliente, s.nombre AS servicio,
              e.nombre AS negocio, ${FECHA_AVISO} AS fecha, ${HORA_AVISO} AS hora
       FROM citas c
       JOIN clientes cl ON cl.id = c.cliente_id
       JOIN servicios s ON s.id = c.servicio_id
       JOIN empresas e ON e.id = c.empresa_id
       WHERE c.id = $1`,
      [citaId],
    )
  ).rows[0];

// Recordatorio de 24 h: citas confirmadas de clientes con cuenta que empiezan dentro de
// 23 a 24 horas. Las marca y las devuelve en el mismo paso (con bloqueo de filas), así
// ninguna se recuerda dos veces aunque la tarea se cruce con otra ejecución. Una cita
// reservada con menos de 24 h de anticipación no entra: el cliente acaba de reservarla.
export const reclamarRecordatorios = async (db: Consultable) =>
  (
    await db.query<DatosAviso>(
      `WITH marcadas AS (
         UPDATE citas SET recordatorio_enviado_en = now()
         WHERE id IN (
           SELECT c.id FROM citas c
           WHERE c.estado = 'CONFIRMADA' AND c.usuario_id IS NOT NULL AND c.recordatorio_enviado_en IS NULL
             AND c.fecha BETWEEN (now() AT TIME ZONE 'America/Bogota')::date
                             AND (now() AT TIME ZONE 'America/Bogota')::date + 1
             AND (c.fecha + c.hora_inicio) AT TIME ZONE 'America/Bogota' > now() + interval '23 hours'
             AND (c.fecha + c.hora_inicio) AT TIME ZONE 'America/Bogota' <= now() + interval '24 hours'
           FOR UPDATE OF c SKIP LOCKED
         )
         RETURNING id, empresa_id, barbero_id, usuario_id, cliente_id, servicio_id, fecha, hora_inicio
       )
       SELECT c.id, c.empresa_id, c.barbero_id, c.usuario_id, cl.nombre AS cliente, s.nombre AS servicio,
              e.nombre AS negocio, ${FECHA_AVISO} AS fecha, ${HORA_AVISO} AS hora
       FROM marcadas c
       JOIN clientes cl ON cl.id = c.cliente_id
       JOIN servicios s ON s.id = c.servicio_id
       JOIN empresas e ON e.id = c.empresa_id`,
    )
  ).rows;
