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
};

const COLUMNAS = `id, radicado, tipo, mensaje, nombre, contacto, estado, respuesta, respondida_en, creado_en, actualizado_en`;

export type DatosPqrs = { tipo: TipoPqrs; mensaje: string; nombre: string; contacto: string; usuarioId: string | null };

// El radicado sale de una secuencia: nunca se repite, aunque lleguen dos a la vez
export const insertarPqrs = async (db: Consultable, d: DatosPqrs) =>
  (
    await db.query<FilaPqrs>(
      `WITH n AS (SELECT nextval('pqrs_numero_seq') AS numero)
       INSERT INTO pqrs (radicado, tipo, mensaje, nombre, contacto, usuario_id)
       SELECT 'PQRS-' || to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY') || '-' || lpad(n.numero::text, 6, '0'),
              $1, $2, $3, $4, $5
       FROM n
       RETURNING ${COLUMNAS}`,
      [d.tipo, d.mensaje, d.nombre, d.contacto, d.usuarioId],
    )
  ).rows[0];

export const listarPqrsDeUsuario = async (db: Consultable, usuarioId: string) =>
  (
    await db.query<FilaPqrs>(`SELECT ${COLUMNAS} FROM pqrs WHERE usuario_id = $1 ORDER BY creado_en DESC`, [usuarioId])
  ).rows;
