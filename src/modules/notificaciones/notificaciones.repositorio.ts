import { ZONA_PLATAFORMA } from '../../config/plataforma.js';
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

// Un celular que no se registra de nuevo (la app lo hace al iniciar sesión y cuando Expo cambia el token) en este
// número de días deja de recibir avisos y se borra: si alguien cierra sesión sin que la app avise, o cambia de
// celular, no se siguen enviando avisos de esa cuenta para siempre.
export const DIAS_VIGENCIA_TOKEN_PUSH = 60;

// Celulares de estos dueños (cuentas o integrantes del equipo) que se usaron hace poco
export const tokensDe = async (db: Consultable, titulares: Titular[]) =>
  (
    await db.query<{ token: string }>(
      `SELECT token FROM dispositivos_push
       WHERE (usuario_id = ANY($1::varchar[]) OR barbero_id = ANY($2::varchar[]))
         AND actualizado_en > now() - make_interval(days => $3)`,
      [
        titulares.flatMap((t) => (t.usuarioId ? [t.usuarioId] : [])),
        titulares.flatMap((t) => (t.barberoId ? [t.barberoId] : [])),
        DIAS_VIGENCIA_TOKEN_PUSH,
      ],
    )
  ).rows.map((f) => f.token);

// Borra los celulares que no se registraron de nuevo en DIAS_VIGENCIA_TOKEN_PUSH días. Devuelve cuántos.
export const borrarTokensVencidos = async (db: Consultable) =>
  (
    (await db.query('DELETE FROM dispositivos_push WHERE actualizado_en < now() - make_interval(days => $1)', [
      DIAS_VIGENCIA_TOKEN_PUSH,
    ])).rowCount ?? 0
  );

// El profesional de la cita y quienes administran el negocio: integrantes activos con rol
// Administrador y cuentas admin de la empresa
export const destinatariosDelNegocio = async (db: Consultable, p: { empresaId: string; barberoId: string }) =>
  (
    await db.query<{ usuario_id: string | null; barbero_id: string | null }>(
      `SELECT NULL::varchar AS usuario_id, b.id AS barbero_id FROM barberos b
       WHERE b.empresa_id = $1 AND b.activo AND (b.id = $2 OR b.es_admin)
       UNION ALL
       SELECT u.id, NULL FROM usuarios u WHERE u.empresa_id = $1 AND u.rol = 'admin'`,
      [p.empresaId, p.barberoId],
    )
  ).rows.map((f): Titular => ({ usuarioId: f.usuario_id, barberoId: f.barbero_id }));

export type ContenidoNotificacion = { tipo: string; titulo: string; texto: string; citaId: string | null };

// Guarda la notificación interna de cada destinatario
export const crearNotificaciones = async (db: Consultable, titulares: Titular[], c: ContenidoNotificacion) => {
  if (!titulares.length) return;
  await db.query(
    `INSERT INTO notificaciones (usuario_id, barbero_id, tipo, titulo, texto, cita_id)
     SELECT t.usuario_id, t.barbero_id, $3, $4, $5, $6
     FROM unnest($1::varchar[], $2::varchar[]) AS t(usuario_id, barbero_id)`,
    [titulares.map((t) => t.usuarioId), titulares.map((t) => t.barberoId), c.tipo, c.titulo, c.texto, c.citaId],
  );
};

export type FilaNotificacion = {
  id: string;
  tipo: string;
  titulo: string;
  texto: string;
  cita_id: string | null;
  leida: boolean;
  leida_en: Date | null;
  creada_en: Date;
  // Zona del negocio de la cita; la de la plataforma si la notificación no tiene cita
  zona_horaria: string;
};

const COLUMNAS_NOTIFICACION = `id, tipo, titulo, texto, cita_id, leida_en IS NOT NULL AS leida, leida_en, creada_en,
  COALESCE((SELECT e.zona_horaria FROM citas ci JOIN empresas e ON e.id = ci.empresa_id WHERE ci.id = notificaciones.cita_id),
           '${ZONA_PLATAFORMA}') AS zona_horaria`;
const DE_TITULAR = 'usuario_id IS NOT DISTINCT FROM $1::varchar AND barbero_id IS NOT DISTINCT FROM $2::varchar';

export const listarNotificaciones = async (
  db: Consultable,
  t: Titular,
  p: { soloNoLeidas: boolean; limite: number; desplazamiento: number },
) =>
  (
    await db.query<FilaNotificacion>(
      `SELECT ${COLUMNAS_NOTIFICACION} FROM notificaciones
       WHERE ${DE_TITULAR} AND (NOT $3::boolean OR leida_en IS NULL)
       ORDER BY creada_en DESC, id LIMIT $4 OFFSET $5`,
      [t.usuarioId, t.barberoId, p.soloNoLeidas, p.limite, p.desplazamiento],
    )
  ).rows;

export const contarNotificaciones = async (db: Consultable, t: Titular) =>
  (
    await db.query<{ total: number; no_leidas: number }>(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE leida_en IS NULL))::int AS no_leidas
       FROM notificaciones WHERE ${DE_TITULAR}`,
      [t.usuarioId, t.barberoId],
    )
  ).rows[0];

// undefined si no existe o no es de quien la pide; si ya estaba leída conserva su fecha
export const marcarLeida = async (db: Consultable, t: Titular, id: string) =>
  (
    await db.query<FilaNotificacion>(
      `UPDATE notificaciones SET leida_en = COALESCE(leida_en, now())
       WHERE id = $3 AND ${DE_TITULAR} RETURNING ${COLUMNAS_NOTIFICACION}`,
      [t.usuarioId, t.barberoId, id],
    )
  ).rows[0];

export const marcarTodasLeidas = async (db: Consultable, t: Titular) =>
  (
    await db.query(`UPDATE notificaciones SET leida_en = now() WHERE ${DE_TITULAR} AND leida_en IS NULL`, [
      t.usuarioId,
      t.barberoId,
    ])
  ).rowCount ?? 0;

export type DatosAviso = {
  id: string;
  empresa_id: string;
  barbero_id: string;
  usuario_id: string | null;
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
      `SELECT c.id, c.empresa_id, c.barbero_id, c.usuario_id, s.nombre AS servicio,
              e.nombre AS negocio, ${FECHA_AVISO} AS fecha, ${HORA_AVISO} AS hora
       FROM citas c
       JOIN servicios s ON s.id = c.servicio_id
       JOIN empresas e ON e.id = c.empresa_id
       WHERE c.id = $1`,
      [citaId],
    )
  ).rows[0];

// Recordatorios de citas confirmadas de clientes con cuenta. Cada uno tiene su columna de
// marca y su ventana de horas antes de la cita: 24 h (23 a 24 h antes) y 2 h (1 a 2 h antes).
// Marca y devuelve las citas en el mismo paso (con bloqueo de filas), así ninguna se recuerda
// dos veces aunque la tarea se cruce con otra ejecución. Una cita reservada con menos
// anticipación que la ventana no entra: el cliente acaba de reservarla. La hora de la cita
// es de pared del negocio, por eso se convierte con su zona horaria.
export const TIPOS_RECORDATORIO = {
  '24h': { columna: 'recordatorio_enviado_en', desdeHoras: 23, hastaHoras: 24 },
  '2h': { columna: 'recordatorio_2h_enviado_en', desdeHoras: 1, hastaHoras: 2 },
} as const;
export type TipoRecordatorio = keyof typeof TIPOS_RECORDATORIO;

export const reclamarRecordatorios = async (db: Consultable, tipo: TipoRecordatorio) => {
  const { columna, desdeHoras, hastaHoras } = TIPOS_RECORDATORIO[tipo];
  return (
    await db.query<DatosAviso>(
      `WITH marcadas AS (
         UPDATE citas SET ${columna} = now()
         WHERE id IN (
           SELECT c.id FROM citas c JOIN empresas ce ON ce.id = c.empresa_id
           WHERE c.estado = 'CONFIRMADA' AND c.usuario_id IS NOT NULL AND c.${columna} IS NULL
             AND c.fecha BETWEEN (now() AT TIME ZONE ce.zona_horaria)::date
                             AND (now() AT TIME ZONE ce.zona_horaria)::date + 1
             AND (c.fecha + c.hora_inicio) AT TIME ZONE ce.zona_horaria > now() + make_interval(hours => $1)
             AND (c.fecha + c.hora_inicio) AT TIME ZONE ce.zona_horaria <= now() + make_interval(hours => $2)
           FOR UPDATE OF c SKIP LOCKED
         )
         RETURNING id, empresa_id, barbero_id, usuario_id, cliente_id, servicio_id, fecha, hora_inicio
       )
       SELECT c.id, c.empresa_id, c.barbero_id, c.usuario_id, s.nombre AS servicio,
              e.nombre AS negocio, ${FECHA_AVISO} AS fecha, ${HORA_AVISO} AS hora
       FROM marcadas c
       JOIN servicios s ON s.id = c.servicio_id
       JOIN empresas e ON e.id = c.empresa_id`,
      [desdeHoras, hastaHoras],
    )
  ).rows;
};

// ---- Avisos de la prueba gratuita (día 10, día 14 y al vencer) ----

export type AvisoPrueba = {
  empresa_id: string;
  nombre: string;
  // 10 y 14: días desde el registro; 15: la prueba ya terminó
  dia: 10 | 14 | 15;
  citas: number;
  ventas: string;
  dias_restantes: number;
};

// Empresas en prueba a las que ya les toca el aviso del día 10, del día 14 (días desde el registro, en
// la zona del negocio) o el de vencimiento (día 15). El del día 10 vale hasta el día 13, el del 14 hasta que
// termine la prueba y el de vencimiento hasta 3 días después, así un servidor apagado ese día no lo pierde
// (y una prueba que venció hace mucho no recibe un aviso tardío). Cada aviso se reclama con INSERT ... ON CONFLICT DO NOTHING sobre
// la clave (empresa, día): solo una ejecución lo obtiene, aunque haya varias instancias. Las que ya pagaron
// un plan (estado distinto de 'trial') o están suspendidas no entran. Devuelve también lo logrado en la
// prueba: citas gestionadas (no canceladas) y ventas (citas completadas).
export const reclamarAvisosPrueba = async (db: Consultable) =>
  (
    await db.query<AvisoPrueba>(
      `WITH candidatas AS (
         SELECT e.id, e.nombre, e.trial_ends_at, e.zona_horaria,
                ((now() AT TIME ZONE e.zona_horaria)::date - (e.created_at AT TIME ZONE e.zona_horaria)::date) AS dias
         FROM empresas e
         WHERE e.estado_suscripcion = 'trial' AND e.suspendida_en IS NULL AND e.trial_ends_at > now() - interval '3 days'
       ),
       toca AS (
         SELECT id, nombre, trial_ends_at, zona_horaria,
                CASE WHEN trial_ends_at <= now() THEN 15 WHEN dias >= 14 THEN 14 WHEN dias >= 10 THEN 10 END AS dia
         FROM candidatas
       ),
       reclamados AS (
         INSERT INTO avisos_prueba (empresa_id, dia)
         SELECT id, dia FROM toca WHERE dia IS NOT NULL
         ON CONFLICT DO NOTHING
         RETURNING empresa_id, dia
       )
       SELECT t.id AS empresa_id, t.nombre, r.dia::int AS dia,
              (SELECT count(*)::int FROM citas c WHERE c.empresa_id = t.id AND c.estado <> 'CANCELADA') AS citas,
              (SELECT coalesce(sum(c.precio), 0) FROM citas c WHERE c.empresa_id = t.id AND c.estado = 'COMPLETADA') AS ventas,
              greatest(0, (t.trial_ends_at AT TIME ZONE t.zona_horaria)::date - (now() AT TIME ZONE t.zona_horaria)::date) AS dias_restantes
       FROM reclamados r JOIN toca t ON t.id = r.empresa_id`,
    )
  ).rows;

// Administradores de una empresa: integrantes activos con rol Administrador y cuentas admin
export const administradoresDe = async (db: Consultable, empresaId: string) =>
  destinatariosDelNegocio(db, { empresaId, barberoId: '' });

// Correos de las cuentas de administración del negocio (el equipo no tiene correo)
export const correosAdministradoresDe = async (db: Consultable, empresaId: string) =>
  (
    await db.query<{ correo: string }>(
      `SELECT correo FROM usuarios WHERE empresa_id = $1 AND rol = 'admin' AND correo IS NOT NULL`,
      [empresaId],
    )
  ).rows.map((f) => f.correo);
