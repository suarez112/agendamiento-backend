import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { Consultable } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';

// Autorización de tratamiento de datos personales (Ley 1581 de 2012).
// La Política de Tratamiento de Datos y los Términos y Condiciones están en la
// tabla documentos_legales: cada versión publicada es una fila nueva y la vigente
// es la más reciente. Publicar una versión nueva = una migración que inserta la fila.
// Cada aceptación guarda su prueba en autorizaciones_datos.

export type TipoDocumento = 'politica_datos' | 'terminos' | 'aviso_privacidad';
export type OrigenAutorizacion = 'registro_empresa' | 'registro_cliente' | 'reserva';

export const DEBE_ACEPTAR = 'Debes aceptar la Política de Tratamiento de Datos y los Términos y Condiciones';
export const NUEVA_VERSION =
  'Publicamos una nueva versión de la Política de Tratamiento de Datos o de los Términos y Condiciones. Acéptala para continuar.';

// Registro de empresa, registro de cliente: los dos deben venir en true
export const aceptacionObligatoria = {
  aceptaPoliticaDatos: z.literal(true, { error: DEBE_ACEPTAR }),
  aceptaTerminos: z.literal(true, { error: DEBE_ACEPTAR }),
};

// Reserva: el invitado debe aceptar; un cliente con sesión, solo si hay una versión nueva
export const aceptacionOpcional = {
  aceptaPoliticaDatos: z.boolean({ error: DEBE_ACEPTAR }).optional(),
  aceptaTerminos: z.boolean({ error: DEBE_ACEPTAR }).optional(),
};

export const aceptoAmbos = (d: { aceptaPoliticaDatos?: boolean; aceptaTerminos?: boolean }) =>
  d.aceptaPoliticaDatos === true && d.aceptaTerminos === true;

// Versión vigente de cada tipo, como subconsulta (una sola fuente de verdad)
const VIGENTE = (tipo: TipoDocumento) =>
  `(SELECT version FROM documentos_legales WHERE tipo = '${tipo}' ORDER BY publicado_en DESC, version DESC LIMIT 1)`;

// Guarda la prueba: quién (cuenta o teléfono del invitado), cuándo (now()), desde
// dónde y las versiones vigentes de los dos documentos
export const registrarAutorizacion = (
  db: Consultable,
  a: {
    origen: OrigenAutorizacion;
    usuarioId?: string | null;
    telefono?: string | null;
    indicativo?: string | null;
    empresaId?: string | null;
    citaId?: string | null;
  },
) =>
  db.query(
    `INSERT INTO autorizaciones_datos
       (origen, usuario_id, telefono, indicativo, empresa_id, cita_id, version_politica, version_terminos)
     VALUES ($1, $2, $3, $4, $5, $6, ${VIGENTE('politica_datos')}, ${VIGENTE('terminos')})`,
    [a.origen, a.usuarioId ?? null, a.telefono ?? null, a.indicativo ?? null, a.empresaId ?? null, a.citaId ?? null],
  );

// true si la cuenta ya aceptó las versiones vigentes de la política y de los términos
export const tieneAutorizacionVigente = async (db: Consultable, usuarioId: string) =>
  (
    await db.query(
      `SELECT 1 FROM autorizaciones_datos
       WHERE usuario_id = $1
         AND version_politica = ${VIGENTE('politica_datos')}
         AND version_terminos = ${VIGENTE('terminos')}
       LIMIT 1`,
      [usuarioId],
    )
  ).rowCount! > 0;

const RUTA_TIPO: Record<string, TipoDocumento> = {
  'politica-datos': 'politica_datos',
  terminos: 'terminos',
  'aviso-privacidad': 'aviso_privacidad',
};

// Endpoints públicos con el texto vigente de cada documento (política, términos y aviso corto) y su versión
export const crearRutasLegal = ({ pool }: { pool: pg.Pool }) => {
  const rutas = Router();

  rutas.get('/:documento', async (req, res) => {
    const tipo = RUTA_TIPO[String(req.params.documento)];
    if (!tipo) throw errores.noEncontrado('Documento no encontrado');
    const { rows } = await pool.query<{ version: string; titulo: string; contenido: string; publicado_en: Date }>(
      `SELECT version, titulo, contenido, publicado_en FROM documentos_legales
       WHERE tipo = $1 ORDER BY publicado_en DESC, version DESC LIMIT 1`,
      [tipo],
    );
    if (!rows[0]) throw errores.noEncontrado('Documento no encontrado');
    const d = rows[0];
    res.json({ tipo, version: d.version, titulo: d.titulo, contenido: d.contenido, publicadoEn: d.publicado_en });
  });

  return rutas;
};
