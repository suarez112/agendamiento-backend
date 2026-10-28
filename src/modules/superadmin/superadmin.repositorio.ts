import type pg from 'pg';
import { COBRO } from '../../config/planes.js';
import { ZONA_PLATAFORMA } from '../../config/plataforma.js';
import type { Consultable } from '../../db/pool.js';

export type FilaSuperadmin = {
  id: string;
  correo: string;
  password_hash: string;
  totp_secreto: string;
  totp_ultimo_paso: string | null;
  version_sesion: number;
  inactivo: boolean;
};

// Minutos sin actividad después de los cuales la sesión se cierra sola
export const MINUTOS_INACTIVIDAD = 15;

const COLUMNAS_SUPERADMIN = `id, correo, password_hash, totp_secreto, totp_ultimo_paso, version_sesion,
  (ultima_actividad IS NULL OR ultima_actividad < now() - make_interval(mins => ${MINUTOS_INACTIVIDAD})) AS inactivo`;

export const buscarSuperadminPorCorreo = async (db: Consultable, correo: string) =>
  (
    await db.query<FilaSuperadmin>(`SELECT ${COLUMNAS_SUPERADMIN} FROM superadmins WHERE lower(correo) = lower($1)`, [
      correo,
    ])
  ).rows[0];

export const buscarSuperadminPorId = async (db: Consultable, id: string) =>
  (await db.query<FilaSuperadmin>(`SELECT ${COLUMNAS_SUPERADMIN} FROM superadmins WHERE id = $1`, [id])).rows[0];

// Entrada correcta: guarda el paso del código usado y reinicia los intentos. Devuelve false si ese
// código (o uno más viejo) ya se había usado: así un código visto por otra persona no sirve de nuevo.
export const registrarEntrada = async (db: Consultable, id: string, paso: number) =>
  (
    (
      await db.query(
        `UPDATE superadmins SET totp_ultimo_paso = $2, intentos_fallidos = 0, bloqueado_hasta = NULL,
                ultima_actividad = now()
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

// Contraseña nueva y, si se envía totpSecreto, también un segundo paso nuevo (sin él conserva el actual).
// Sube la versión de la sesión: cierra las sesiones abiertas.
export const reiniciarSuperadmin = async (
  db: Consultable,
  correo: string,
  d: { passwordHash: string; totpSecreto?: string },
) =>
  (
    (
      await db.query(
        `UPDATE superadmins
         SET password_hash = $2, totp_secreto = COALESCE($3::text, totp_secreto),
             totp_ultimo_paso = CASE WHEN $3::text IS NULL THEN totp_ultimo_paso END,
             version_sesion = version_sesion + 1, ultima_actividad = NULL,
             intentos_fallidos = 0, bloqueado_hasta = NULL
         WHERE lower(correo) = lower($1)`,
        [correo, d.passwordHash, d.totpSecreto ?? null],
      )
    ).rowCount ?? 0
  ) > 0;

// Marca actividad ahora. Solo cuenta si la sesión sigue viva (la condición evita revivir una vencida).
export const registrarActividadDeSesion = async (db: Consultable, id: string) =>
  (
    (
      await db.query(
        `UPDATE superadmins SET ultima_actividad = now()
         WHERE id = $1 AND ultima_actividad >= now() - make_interval(mins => $2)`,
        [id, MINUTOS_INACTIVIDAD],
      )
    ).rowCount ?? 0
  ) > 0;

// Cierra la sesión: sube la versión (todos los tokens anteriores dejan de servir) y borra la actividad
export const cerrarSesionSuperadmin = async (db: Consultable, id: string) => {
  await db.query('UPDATE superadmins SET version_sesion = version_sesion + 1, ultima_actividad = NULL WHERE id = $1', [id]);
};

// Elimina un superadmin, salvo que sea el último. Devuelve 'eliminado', 'no_existe' o 'ultimo'.
// Bloquea todas las filas mientras cuenta, para que dos eliminaciones a la vez no dejen la tabla vacía.
export const eliminarSuperadmin = async (tx: pg.PoolClient, correo: string): Promise<'eliminado' | 'no_existe' | 'ultimo'> => {
  const filas = (await tx.query<{ id: string; correo: string }>('SELECT id, correo FROM superadmins FOR UPDATE')).rows;
  const objetivo = filas.find((f) => f.correo.toLowerCase() === correo.toLowerCase());
  if (!objetivo) return 'no_existe';
  if (filas.length <= 1) return 'ultimo';
  await tx.query('DELETE FROM superadmins WHERE id = $1', [objetivo.id]);
  return 'eliminado';
};

export const listarCorreosSuperadmin = async (db: Consultable) =>
  (await db.query<{ correo: string }>('SELECT correo FROM superadmins ORDER BY creado_en')).rows.map((f) => f.correo);

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
         AND ($3::date IS NULL OR (creado_en AT TIME ZONE '${ZONA_PLATAFORMA}')::date >= $3)
         AND ($4::date IS NULL OR (creado_en AT TIME ZONE '${ZONA_PLATAFORMA}')::date <= $4)
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

// Cada negocio con su estado calculado hoy (fecha en la zona de cada negocio). Sigue la misma regla que buscarSuscripcion
// (empresas.repositorio.ts): suspendido; si no, prueba o activo mientras no pase la fecha de fin; si no, vencido.
// Un negocio activo sin fecha de fin (anterior a los planes) no vence.
const NEGOCIOS = `(
  SELECT e.id, e.nombre, e.codigo_acceso, e.ciudad, e.departamento, e.plan_equipo, e.plan_suscripcion AS periodo,
         e.estado_suscripcion, e.suspendida_en, e.suspension_motivo, e.categoria, e.direccion,
         e.nombre_administradora, e.trial_ends_at, e.fecha_pago, e.dias_prueba_sumados, e.zona_horaria,
         (e.created_at AT TIME ZONE e.zona_horaria)::date AS registro,
         f.fin, f.hoy, f.fin - f.hoy AS dias,
         CASE WHEN e.suspendida_en IS NOT NULL THEN 'suspendido'
              WHEN e.estado_suscripcion IN ('trial', 'activa') AND (f.fin IS NULL OR f.fin > f.hoy)
                THEN CASE e.estado_suscripcion WHEN 'trial' THEN 'prueba' ELSE 'activo' END
              ELSE 'vencido' END AS estado,
         (SELECT count(*)::int FROM barberos b WHERE b.empresa_id = e.id AND b.activo) AS equipo_activo,
         (SELECT count(*)::int FROM barberos b WHERE b.empresa_id = e.id AND b.activo AND b.atiende_clientes) AS cobrados
  FROM empresas e
  CROSS JOIN LATERAL (
    SELECT CASE e.estado_suscripcion
             WHEN 'trial' THEN (e.trial_ends_at AT TIME ZONE e.zona_horaria)::date
             WHEN 'activa' THEN e.suscripcion_fin
           END AS fin,
           (now() AT TIME ZONE e.zona_horaria)::date AS hoy
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
  // Profesionales que atienden clientes (los que se cobran)
  cobrados: number;
  zona_horaria: string;
};

export type FiltrosNegocios = { buscar?: string; estado?: EstadoNegocio; limite: number; desplazamiento: number };

export const listarNegocios = async (db: Consultable, f: FiltrosNegocios) =>
  (
    await db.query<FilaNegocio & { total: number }>(
      `SELECT id, nombre, codigo_acceso, ciudad, departamento, plan_equipo, periodo, estado, dias,
              to_char(registro, 'YYYY-MM-DD') AS registro, equipo_activo, cobrados, zona_horaria, count(*) OVER ()::int AS total
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
              (SELECT count(*)::int FROM citas c JOIN empresas ce ON ce.id = c.empresa_id
               WHERE c.fecha = (now() AT TIME ZONE ce.zona_horaria)::date AND c.estado <> 'CANCELADA') AS citas_hoy
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
              to_char(registro, 'YYYY-MM-DD') AS registro, equipo_activo, cobrados, zona_horaria, estado_suscripcion, categoria, direccion,
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
                                   AND to_char(fecha, 'YYYY-MM') = to_char(now() AT TIME ZONE (SELECT zona_horaria FROM empresas WHERE id = $1), 'YYYY-MM'))::int AS mes,
                COALESCE(sum(precio) FILTER (WHERE estado = 'COMPLETADA'), 0)::text AS ventas,
                COALESCE(sum(precio) FILTER (WHERE estado = 'COMPLETADA'
                                               AND to_char(fecha, 'YYYY-MM') = to_char(now() AT TIME ZONE (SELECT zona_horaria FROM empresas WHERE id = $1), 'YYYY-MM')), 0)::text AS ventas_mes,
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

// ---- Estadísticas para gráficos (solo cifras de la plataforma, nunca datos de clientes) ----

// Fecha de hoy en la zona de la plataforma (gráficos de toda la plataforma, no de un negocio)
const HOY = `(now() AT TIME ZONE '${ZONA_PLATAFORMA}')::date`;

export const estadisticasPlataforma = async (db: Consultable) => {
  const [nuevosPorMes, porEstado, porPlan, citasPorDia, departamentos, conversion, porVencer, activosPorPlan] =
    await Promise.all([
      db.query<{ mes: string; total: number }>(
        `SELECT to_char(m.mes, 'YYYY-MM') AS mes, count(n.id)::int AS total
         FROM generate_series(date_trunc('month', ${HOY}::timestamp) - interval '11 months',
                              date_trunc('month', ${HOY}::timestamp), interval '1 month') AS m(mes)
         LEFT JOIN ${NEGOCIOS} ON date_trunc('month', n.registro::timestamp) = m.mes
         GROUP BY m.mes ORDER BY m.mes`,
      ),
      db.query<{ estado: string; total: number }>(
        `SELECT estado, count(*)::int AS total FROM ${NEGOCIOS} GROUP BY estado`,
      ),
      db.query<{ plan_equipo: string; total: number; activos: number }>(
        `SELECT plan_equipo, count(*)::int AS total, count(*) FILTER (WHERE estado = 'activo')::int AS activos
         FROM ${NEGOCIOS} GROUP BY plan_equipo`,
      ),
      db.query<{ dia: string; total: number }>(
        `SELECT to_char(d.dia, 'YYYY-MM-DD') AS dia, count(c.id)::int AS total
         FROM generate_series((${HOY} - 29)::timestamp, ${HOY}::timestamp, interval '1 day') AS d(dia)
         LEFT JOIN citas c ON c.fecha = d.dia::date AND c.estado <> 'CANCELADA'
         GROUP BY d.dia ORDER BY d.dia`,
      ),
      db.query<{ departamento: string; total: number }>(
        `SELECT departamento, count(*)::int AS total FROM ${NEGOCIOS}
         WHERE departamento IS NOT NULL GROUP BY departamento ORDER BY total DESC, departamento LIMIT 5`,
      ),
      // Base: negocios que ya pagaron o cuya prueba ya terminó (uno que sigue en su prueba aún no pudo convertirse)
      db.query<{ base: number; convertidos: number }>(
        `SELECT count(*) FILTER (WHERE fecha_pago IS NOT NULL OR estado_suscripcion = 'activa' OR trial_ends_at <= now())::int AS base,
                count(*) FILTER (WHERE fecha_pago IS NOT NULL OR estado_suscripcion = 'activa')::int AS convertidos
         FROM ${NEGOCIOS}`,
      ),
      db.query<{ id: string; nombre: string; codigo_acceso: string; estado: string; dias: number; fecha_fin: string; total: number }>(
        `SELECT id, nombre, codigo_acceso, estado, dias, to_char(fin, 'YYYY-MM-DD') AS fecha_fin, count(*) OVER ()::int AS total
         FROM ${NEGOCIOS}
         WHERE estado IN ('prueba', 'activo') AND dias IS NOT NULL AND dias <= $1::int
         ORDER BY dias, nombre LIMIT 50`,
        [DIAS_POR_VENCER],
      ),
      activosPorProfesionales(db),
    ]);
  return {
    nuevosPorMes: nuevosPorMes.rows,
    porEstado: porEstado.rows,
    porPlan: porPlan.rows,
    citasPorDia: citasPorDia.rows,
    departamentos: departamentos.rows,
    conversion: conversion.rows[0],
    porVencer: porVencer.rows,
    activosPorProfesionales: activosPorPlan,
  };
};

// Negocios activos agrupados por profesionales cobrados (mínimo 1, como el precio) y periodo. Un activo de antes
// de los planes no tiene periodo: no hay precio con qué estimarlo.
export const activosPorProfesionales = async (db: Consultable) =>
  (
    await db.query<{ profesionales: number; periodo: 'mensual' | 'anual' | null; negocios: number; cobrados_reales: number }>(
      `SELECT GREATEST(cobrados, 1) AS profesionales, periodo, count(*)::int AS negocios, sum(cobrados)::int AS cobrados_reales
       FROM ${NEGOCIOS} WHERE estado = 'activo' GROUP BY GREATEST(cobrados, 1), periodo`,
    )
  ).rows;

// Negocios por número de profesionales cobrados (mínimo 1, como el precio; máximo 10) y cuántos están activos
export const negociosPorProfesionales = async (db: Consultable) =>
  (
    await db.query<{ profesionales: number; total: number; activos: number }>(
      `SELECT LEAST(GREATEST(cobrados, 1), $1::int) AS profesionales, count(*)::int AS total,
              count(*) FILTER (WHERE estado = 'activo')::int AS activos
       FROM ${NEGOCIOS} GROUP BY 1`,
      [COBRO.maxProfesionales],
    )
  ).rows;

// Cargos proporcionales creados en el mes actual (zona de la plataforma), por estado
export const cargosDelMes = async (db: Consultable) =>
  (
    await db.query<{ estado: 'pendiente' | 'pagado'; cantidad: number; total: string }>(
      `SELECT estado, count(*)::int AS cantidad, COALESCE(sum(monto), 0) AS total
       FROM cargos WHERE date_trunc('month', fecha::timestamp) = date_trunc('month', ${HOY}::timestamp)
       GROUP BY estado`,
    )
  ).rows;

// Ingresos brutos estimados por mes: cada activación de plan (activaciones_plan, por su fecha) y cada cargo
// proporcional pagado por separado (por su fecha de pago). Un cargo pagado junto con una activación no se
// cuenta dos veces: ya va dentro del precio de esa activación. Cada fila es una transacción de la pasarela.
// Solo los meses con movimiento; el servicio rellena los demás con ceros.
export const ingresosPorMes = async (db: Consultable) => {
  const [meses, actual] = await Promise.all([
    db.query<{ mes: string; total: string; activaciones: number; cargos: number }>(
      `SELECT to_char(fecha, 'YYYY-MM') AS mes, sum(monto) AS total,
              count(*) FILTER (WHERE tipo = 'activacion')::int AS activaciones,
              count(*) FILTER (WHERE tipo = 'cargo')::int AS cargos
       FROM (
         SELECT fecha, precio AS monto, 'activacion' AS tipo FROM activaciones_plan
         UNION ALL
         SELECT fecha_pago, monto, 'cargo' FROM cargos WHERE estado = 'pagado' AND pagado_por <> 'activacion'
       ) t GROUP BY 1 ORDER BY 1`,
    ),
    db.query<{ mes: string }>(`SELECT to_char(${HOY}, 'YYYY-MM') AS mes`),
  ]);
  return { meses: meses.rows, mesActual: actual.rows[0].mes };
};
