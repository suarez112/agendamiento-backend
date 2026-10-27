import { ZONA_PLATAFORMA } from '../../config/plataforma.js';
import type { Consultable } from '../../db/pool.js';

export const TIPOS_PQRS = ['peticion', 'queja', 'reclamo', 'sugerencia'] as const;
export const ESTADOS_PQRS = ['recibida', 'en_proceso', 'resuelta', 'cerrada'] as const;
export type TipoPqrs = (typeof TIPOS_PQRS)[number];
export type EstadoPqrs = (typeof ESTADOS_PQRS)[number];

export type FilaPqrs = {
  id: string;
  radicado: string;
  tipo: TipoPqrs;
  mensaje: string;
  nombre: string;
  contacto: string;
  estado: EstadoPqrs;
  respuesta: string | null;
  respondida_en: Date | null;
  creado_en: Date;
  actualizado_en: Date;
  // Prioridad (1 = la más urgente) según el plan del negocio de quien radicó, y fecha límite de respuesta
  plan_equipo: string;
  prioridad: number;
  dias_habiles: number;
  fecha_limite: Date;
};

const COLUMNAS = `id, radicado, tipo, mensaje, nombre, contacto, estado, respuesta, respondida_en, creado_en, actualizado_en,
  plan_equipo, prioridad, dias_habiles, fecha_limite`;

export type DatosPqrs = {
  tipo: TipoPqrs;
  mensaje: string;
  nombre: string;
  contacto: string;
  usuarioId: string | null;
  empresaId: string | null;
  planEquipo: string;
  prioridad: number;
  diasHabiles: number;
};

// El radicado sale de una secuencia: nunca se repite, aunque lleguen dos a la vez
export const insertarPqrs = async (db: Consultable, d: DatosPqrs) =>
  (
    await db.query<FilaPqrs>(
      `WITH n AS (SELECT nextval('pqrs_numero_seq') AS numero)
       INSERT INTO pqrs (radicado, tipo, mensaje, nombre, contacto, usuario_id, empresa_id, plan_equipo, prioridad,
                         dias_habiles, fecha_limite)
       SELECT 'PQRS-' || to_char(now() AT TIME ZONE '${ZONA_PLATAFORMA}', 'YYYY') || '-' || lpad(n.numero::text, 6, '0'),
              $1, $2, $3, $4, $5, $6, $7, $8, $9::int,
              -- Fin del día hábil número $9 después de hoy (lunes a viernes), en la zona de la plataforma
              ((SELECT d::date FROM generate_series((now() AT TIME ZONE '${ZONA_PLATAFORMA}')::date + 1,
                                                    (now() AT TIME ZONE '${ZONA_PLATAFORMA}')::date + 60, interval '1 day') d
                WHERE extract(isodow FROM d) < 6 ORDER BY d OFFSET $9::int - 1 LIMIT 1)
               + time '23:59:59') AT TIME ZONE '${ZONA_PLATAFORMA}'
       FROM n
       RETURNING ${COLUMNAS}`,
      [d.tipo, d.mensaje, d.nombre, d.contacto, d.usuarioId, d.empresaId, d.planEquipo, d.prioridad, d.diasHabiles],
    )
  ).rows[0];

export const listarPqrsDeUsuario = async (db: Consultable, usuarioId: string) =>
  (
    await db.query<FilaPqrs>(`SELECT ${COLUMNAS} FROM pqrs WHERE usuario_id = $1 ORDER BY creado_en DESC`, [usuarioId])
  ).rows;

// ---- Para el superadmin: todas las PQRS de la plataforma ----

export type FilaPqrsSoporte = FilaPqrs & { con_cuenta: boolean };

const COLUMNAS_SOPORTE = `${COLUMNAS}, usuario_id IS NOT NULL AS con_cuenta`;

export type FiltrosPqrs = { estado?: EstadoPqrs; tipo?: TipoPqrs; limite: number; desplazamiento: number };

// Las sin resolver primero, por prioridad (plan Pro antes que Equipo y Emprendedor) y fecha límite
export const listarTodasLasPqrs = async (db: Consultable, f: FiltrosPqrs) =>
  (
    await db.query<FilaPqrsSoporte & { total: number }>(
      `SELECT ${COLUMNAS_SOPORTE}, count(*) OVER ()::int AS total
       FROM pqrs
       WHERE ($1::varchar IS NULL OR estado = $1) AND ($2::varchar IS NULL OR tipo = $2)
       ORDER BY (estado IN ('resuelta', 'cerrada')), prioridad, fecha_limite, creado_en
       LIMIT $3 OFFSET $4`,
      [f.estado ?? null, f.tipo ?? null, f.limite, f.desplazamiento],
    )
  ).rows;

// bloquear = true la deja bloqueada hasta cerrar la transacción (para cambiarla sin carreras)
export const buscarPqrsPorRadicado = async (db: Consultable, radicado: string, bloquear = false) =>
  (
    await db.query<FilaPqrsSoporte>(
      `SELECT ${COLUMNAS_SOPORTE} FROM pqrs WHERE radicado = $1${bloquear ? ' FOR UPDATE' : ''}`,
      [radicado],
    )
  ).rows[0];

// Sin respuesta nueva conserva la anterior
export const actualizarPqrs = async (db: Consultable, radicado: string, estado: EstadoPqrs, respuesta: string | null) =>
  (
    await db.query<FilaPqrsSoporte>(
      `UPDATE pqrs
       SET estado = $2, respuesta = COALESCE($3, respuesta),
           respondida_en = CASE WHEN $3::varchar IS NOT NULL THEN now() ELSE respondida_en END,
           actualizado_en = now()
       WHERE radicado = $1
       RETURNING ${COLUMNAS_SOPORTE}`,
      [radicado, estado, respuesta],
    )
  ).rows[0];
