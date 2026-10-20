import type { Consultable } from '../../db/pool.js';

export type FilaSuperadmin = {
  id: string;
  correo: string;
  password_hash: string;
  totp_secreto: string;
  totp_ultimo_paso: string | null;
  version_sesion: number;
  bloqueado: boolean;
};

const COLUMNAS_SUPERADMIN = `id, correo, password_hash, totp_secreto, totp_ultimo_paso, version_sesion,
  COALESCE(bloqueado_hasta > now(), false) AS bloqueado`;

export const buscarSuperadminPorCorreo = async (db: Consultable, correo: string) =>
  (
    await db.query<FilaSuperadmin>(`SELECT ${COLUMNAS_SUPERADMIN} FROM superadmins WHERE lower(correo) = lower($1)`, [
      correo,
    ])
  ).rows[0];

export const buscarSuperadminPorId = async (db: Consultable, id: string) =>
  (await db.query<FilaSuperadmin>(`SELECT ${COLUMNAS_SUPERADMIN} FROM superadmins WHERE id = $1`, [id])).rows[0];

export const MAX_INTENTOS = 5;
export const MINUTOS_BLOQUEO = 15;

// Cuenta un intento fallido; al llegar al máximo bloquea la cuenta unos minutos.
// Si el bloqueo anterior ya venció, la cuenta empieza de cero.
export const registrarIntentoFallido = async (db: Consultable, id: string) => {
  await db.query(
    `UPDATE superadmins s
     SET intentos_fallidos = n.valor,
         bloqueado_hasta = CASE WHEN n.valor >= $2 THEN now() + make_interval(mins => $3) END
     FROM (SELECT id, CASE WHEN bloqueado_hasta IS NOT NULL AND bloqueado_hasta <= now() THEN 1
                           ELSE intentos_fallidos + 1 END AS valor
           FROM superadmins WHERE id = $1) n
     WHERE s.id = n.id`,
    [id, MAX_INTENTOS, MINUTOS_BLOQUEO],
  );
};

// Entrada correcta: guarda el paso del código usado y reinicia los intentos. Devuelve false si ese
// código (o uno más viejo) ya se había usado: así un código visto por otra persona no sirve de nuevo.
export const registrarEntrada = async (db: Consultable, id: string, paso: number) =>
  (
    (
      await db.query(
        `UPDATE superadmins SET totp_ultimo_paso = $2, intentos_fallidos = 0, bloqueado_hasta = NULL
         WHERE id = $1 AND (totp_ultimo_paso IS NULL OR totp_ultimo_paso < $2)`,
        [id, paso],
      )
    ).rowCount ?? 0
  ) > 0;

export const insertarSuperadmin = async (
  db: Consultable,
  d: { correo: string; passwordHash: string; totpSecreto: string },
) => {
  await db.query('INSERT INTO superadmins (correo, password_hash, totp_secreto) VALUES ($1, $2, $3)', [
    d.correo,
    d.passwordHash,
    d.totpSecreto,
  ]);
};

// Contraseña y segundo paso nuevos. Sube la versión de la sesión: cierra las sesiones abiertas.
export const reiniciarSuperadmin = async (
  db: Consultable,
  correo: string,
  d: { passwordHash: string; totpSecreto: string },
) =>
  (
    (
      await db.query(
        `UPDATE superadmins
         SET password_hash = $2, totp_secreto = $3, totp_ultimo_paso = NULL, version_sesion = version_sesion + 1,
             intentos_fallidos = 0, bloqueado_hasta = NULL
         WHERE lower(correo) = lower($1)`,
        [correo, d.passwordHash, d.totpSecreto],
      )
    ).rowCount ?? 0
  ) > 0;

// ---- Registro de actividad (solo se agregan filas; la base rechaza cambiarlas o borrarlas) ----

export type EntradaActividad = {
  superadminId: string;
  superadminCorreo: string;
  accion: string;
  empresa?: { id: string; codigo_acceso: string; nombre: string } | null;
  referencia?: string | null;
  detalle?: Record<string, unknown>;
  motivo?: string | null;
};

export const registrarActividad = async (db: Consultable, e: EntradaActividad) => {
  await db.query(
    `INSERT INTO actividad_superadmin
       (superadmin_id, superadmin_correo, accion, empresa_id, empresa_codigo, empresa_nombre, referencia, detalle, motivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      e.superadminId,
      e.superadminCorreo,
      e.accion,
      e.empresa?.id ?? null,
      e.empresa?.codigo_acceso ?? null,
      e.empresa?.nombre ?? null,
      e.referencia ?? null,
      JSON.stringify(e.detalle ?? {}),
      e.motivo ?? null,
    ],
  );
};

export type FiltrosActividad = {
  accion?: string;
  empresaId?: string;
  desde?: string;
  hasta?: string;
  limite: number;
  desplazamiento: number;
};

export type FilaActividad = {
  id: string;
  superadmin_correo: string;
  accion: string;
  empresa_id: string | null;
  empresa_codigo: string | null;
  empresa_nombre: string | null;
  referencia: string | null;
  detalle: Record<string, unknown>;
  motivo: string | null;
  creado_en: Date;
  total: number;
};

export const listarActividad = async (db: Consultable, f: FiltrosActividad) =>
  (
    await db.query<FilaActividad>(
      `SELECT id::text, superadmin_correo, accion, empresa_id, empresa_codigo, empresa_nombre, referencia, detalle,
              motivo, creado_en, count(*) OVER ()::int AS total
       FROM actividad_superadmin
       WHERE ($1::varchar IS NULL OR accion = $1)
         AND ($2::varchar IS NULL OR empresa_id = $2)
         AND ($3::date IS NULL OR (creado_en AT TIME ZONE 'America/Bogota')::date >= $3)
         AND ($4::date IS NULL OR (creado_en AT TIME ZONE 'America/Bogota')::date <= $4)
       ORDER BY creado_en DESC, id DESC
       LIMIT $5 OFFSET $6`,
      [f.accion ?? null, f.empresaId ?? null, f.desde ?? null, f.hasta ?? null, f.limite, f.desplazamiento],
    )
  ).rows;

// ---- Negocios ----

export const ESTADOS_NEGOCIO = ['prueba', 'activo', 'vencido', 'suspendido', 'por_vencer'] as const;
export type EstadoNegocio = (typeof ESTADOS_NEGOCIO)[number];
// Días restantes a partir de los cuales un negocio cuenta como "por vencer"
export const DIAS_POR_VENCER = 7;

// Cada negocio con su estado calculado hoy (hora de Colombia). Sigue la misma regla que buscarSuscripcion
// (empresas.repositorio.ts): suspendido; si no, prueba o activo mientras no pase la fecha de fin; si no, vencido.
// Un negocio activo sin fecha de fin (anterior a los planes) no vence.
const NEGOCIOS = `(
  SELECT e.id, e.nombre, e.codigo_acceso, e.ciudad, e.departamento, e.plan_equipo, e.plan_suscripcion AS periodo,
         e.estado_suscripcion, e.suspendida_en, e.suspension_motivo, e.categoria, e.direccion,
         e.nombre_administradora, e.trial_ends_at, e.fecha_pago, e.dias_prueba_sumados,
         (e.created_at::timestamptz AT TIME ZONE 'America/Bogota')::date AS registro,
         f.fin, f.hoy, f.fin - f.hoy AS dias,
         CASE WHEN e.suspendida_en IS NOT NULL THEN 'suspendido'
              WHEN e.estado_suscripcion IN ('trial', 'activa') AND (f.fin IS NULL OR f.fin > f.hoy)
                THEN CASE e.estado_suscripcion WHEN 'trial' THEN 'prueba' ELSE 'activo' END
              ELSE 'vencido' END AS estado,
         (SELECT count(*)::int FROM barberos b WHERE b.empresa_id = e.id AND b.activo) AS equipo_activo
  FROM empresas e
  CROSS JOIN LATERAL (
    SELECT CASE e.estado_suscripcion
             WHEN 'trial' THEN (e.trial_ends_at AT TIME ZONE 'America/Bogota')::date
             WHEN 'activa' THEN e.suscripcion_fin
           END AS fin,
           (now() AT TIME ZONE 'America/Bogota')::date AS hoy
  ) f
) n`;

export type FilaNegocio = {
  id: string;
  nombre: string;
  codigo_acceso: string;
  ciudad: string | null;
  departamento: string | null;
  plan_equipo: string;
  periodo: 'mensual' | 'anual' | null;
  estado: 'prueba' | 'activo' | 'vencido' | 'suspendido';
  dias: number | null;
  registro: string;
  equipo_activo: number;
};

export type FiltrosNegocios = { buscar?: string; estado?: EstadoNegocio; limite: number; desplazamiento: number };

export const listarNegocios = async (db: Consultable, f: FiltrosNegocios) =>
  (
    await db.query<FilaNegocio & { total: number }>(
      `SELECT id, nombre, codigo_acceso, ciudad, departamento, plan_equipo, periodo, estado, dias,
              to_char(registro, 'YYYY-MM-DD') AS registro, equipo_activo, count(*) OVER ()::int AS total
       FROM ${NEGOCIOS}
       WHERE ($1::varchar IS NULL OR position(lower($1) in lower(nombre)) > 0 OR position(lower($1) in lower(codigo_acceso)) > 0)
         AND ($2::varchar IS NULL
              OR n.estado = $2
              OR ($2 = 'por_vencer' AND n.estado IN ('prueba', 'activo') AND n.dias IS NOT NULL AND n.dias <= $3::int))
       ORDER BY registro DESC, nombre
       LIMIT $4 OFFSET $5`,
      [f.buscar ?? null, f.estado ?? null, DIAS_POR_VENCER, f.limite, f.desplazamiento],
    )
  ).rows;

export const resumenPlataforma = async (db: Consultable) =>
  (
    await db.query<{
      total: number;
      en_prueba: number;
      activos: number;
      vencidos: number;
      suspendidos: number;
      nuevos_mes: number;
      por_vencer: number;
      citas_hoy: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE estado = 'prueba')::int AS en_prueba,
              count(*) FILTER (WHERE estado = 'activo')::int AS activos,
              count(*) FILTER (WHERE estado = 'vencido')::int AS vencidos,
              count(*) FILTER (WHERE estado = 'suspendido')::int AS suspendidos,
              count(*) FILTER (WHERE to_char(registro, 'YYYY-MM') = to_char(hoy, 'YYYY-MM'))::int AS nuevos_mes,
              count(*) FILTER (WHERE estado IN ('prueba', 'activo') AND dias IS NOT NULL AND dias <= $1::int)::int AS por_vencer,
              (SELECT count(*)::int FROM citas
               WHERE fecha = (now() AT TIME ZONE 'America/Bogota')::date AND estado <> 'CANCELADA') AS citas_hoy
       FROM ${NEGOCIOS}`,
      [DIAS_POR_VENCER],
    )
  ).rows[0];

export type FilaDetalleNegocio = FilaNegocio & {
  estado_suscripcion: string;
  categoria: string | null;
  direccion: string | null;
  nombre_administradora: string | null;
  trial_ends_at: Date | null;
  fecha_pago: string | null;
  fecha_fin: string | null;
  dias_prueba_sumados: number | null;
  suspendida_en: Date | null;
  suspension_motivo: string | null;
};

export const buscarNegocio = async (db: Consultable, id: string) =>
  (
    await db.query<FilaDetalleNegocio>(
      `SELECT id, nombre, codigo_acceso, ciudad, departamento, plan_equipo, periodo, estado, dias,
              to_char(registro, 'YYYY-MM-DD') AS registro, equipo_activo, estado_suscripcion, categoria, direccion,
              nombre_administradora, trial_ends_at, to_char(fecha_pago, 'YYYY-MM-DD') AS fecha_pago,
              to_char(fin, 'YYYY-MM-DD') AS fecha_fin, dias_prueba_sumados, suspendida_en, suspension_motivo
       FROM ${NEGOCIOS} WHERE n.id = $1`,
      [id],
    )
  ).rows[0];

// Solo cifras: nunca nombres, teléfonos ni otros datos de los clientes del negocio
export type CifrasNegocio = {
  clientes: number;
  servicios: number;
  productos: number;
  equipo_admins: number;
  equipo_empleados: number;
  citas_total: number;
  citas_confirmadas: number;
  citas_completadas: number;
  citas_canceladas: number;
  citas_mes: number;
  ventas_total: string;
  ventas_mes: string;
  ultima_cita: string | null;
};

export const cifrasDeNegocio = async (db: Consultable, empresaId: string) =>
  (
    await db.query<CifrasNegocio>(
      `SELECT
         (SELECT count(*)::int FROM clientes WHERE empresa_id = $1) AS clientes,
         (SELECT count(*)::int FROM servicios WHERE empresa_id = $1 AND activo) AS servicios,
         (SELECT count(*)::int FROM productos WHERE empresa_id = $1) AS productos,
         (SELECT count(*)::int FROM barberos WHERE empresa_id = $1 AND activo AND es_admin) AS equipo_admins,
         (SELECT count(*)::int FROM barberos WHERE empresa_id = $1 AND activo AND NOT es_admin) AS equipo_empleados,
         c.total AS citas_total, c.confirmadas AS citas_confirmadas, c.completadas AS citas_completadas,
         c.canceladas AS citas_canceladas, c.mes AS citas_mes,
         c.ventas AS ventas_total, c.ventas_mes, c.ultima AS ultima_cita
       FROM (
         SELECT count(*)::int AS total,
                count(*) FILTER (WHERE estado = 'CONFIRMADA')::int AS confirmadas,
                count(*) FILTER (WHERE estado = 'COMPLETADA')::int AS completadas,
                count(*) FILTER (WHERE estado = 'CANCELADA')::int AS canceladas,
                count(*) FILTER (WHERE estado <> 'CANCELADA'
                                   AND to_char(fecha, 'YYYY-MM') = to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM'))::int AS mes,
                COALESCE(sum(precio) FILTER (WHERE estado = 'COMPLETADA'), 0)::text AS ventas,
                COALESCE(sum(precio) FILTER (WHERE estado = 'COMPLETADA'
                                               AND to_char(fecha, 'YYYY-MM') = to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM')), 0)::text AS ventas_mes,
                to_char(max(fecha), 'YYYY-MM-DD') AS ultima
         FROM citas WHERE empresa_id = $1
       ) c`,
      [empresaId],
    )
  ).rows[0];

export const correoAdministradora = async (db: Consultable, empresaId: string) =>
  (
    await db.query<{ correo: string }>(
      `SELECT correo FROM usuarios WHERE empresa_id = $1 AND rol = 'admin' ORDER BY created_at LIMIT 1`,
      [empresaId],
    )
  ).rows[0]?.correo ?? null;

// Datos del negocio que se copian al registro de actividad
export type EmpresaResumida = { id: string; codigo_acceso: string; nombre: string; estado_suscripcion: string };

// Bloquea la fila mientras se decide (dentro de una transacción)
export const buscarEmpresaParaCambio = async (db: Consultable, id: string) =>
  (
    await db.query<EmpresaResumida & { suspendida: boolean }>(
      `SELECT id, codigo_acceso, nombre, estado_suscripcion, suspendida_en IS NOT NULL AS suspendida
       FROM empresas WHERE id = $1 FOR UPDATE`,
      [id],
    )
  ).rows[0];

export const suspenderEmpresa = async (db: Consultable, id: string, motivo: string) => {
  await db.query('UPDATE empresas SET suspendida_en = now(), suspension_motivo = $2 WHERE id = $1', [id, motivo]);
};

export const reactivarEmpresa = async (db: Consultable, id: string) => {
  await db.query('UPDATE empresas SET suspendida_en = NULL, suspension_motivo = NULL WHERE id = $1', [id]);
};

// La prueba se alarga desde su fin, o desde ahora si ya había terminado. Devuelve el fin anterior y el nuevo.
export const extenderPrueba = async (db: Consultable, id: string, dias: number) =>
  (
    await db.query<{ anterior: Date; nueva: Date }>(
      `UPDATE empresas e SET trial_ends_at = GREATEST(e.trial_ends_at, now()) + make_interval(days => $2)
       FROM (SELECT id, trial_ends_at FROM empresas WHERE id = $1) previa
       WHERE e.id = previa.id RETURNING previa.trial_ends_at AS anterior, e.trial_ends_at AS nueva`,
      [id, dias],
    )
  ).rows[0];
