import { ZONA_PLATAFORMA } from '../../config/plataforma.js';
import { aIsoEnZona } from '../../shared/zonaHoraria.js';
import { isIP } from 'node:net';
import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { Consultable } from '../../db/pool.js';
import { parsear } from '../../shared/http/validacion.js';
import { errores } from '../../shared/errores.js';
import { tokenDe } from '../auth/guardias.js';
import type { Titular } from '../notificaciones/notificaciones.repositorio.js';

// Autorización de tratamiento de datos personales (Ley 1581 de 2012).
// La Política de Tratamiento de Datos y los Términos y Condiciones están en la
// tabla documentos_legales: cada versión publicada es una fila nueva y la vigente
// es la más reciente. Publicar una versión nueva = una migración que inserta la fila.
// Cada aceptación guarda su prueba en auditoria_autorizaciones (solo inserción; autorizaciones_datos quedó como historial).

export type TipoDocumento = 'politica_datos' | 'terminos' | 'aviso_privacidad';
export type CanalAutorizacion = 'registro_empresa' | 'registro_cliente' | 'reserva_invitado' | 'nueva_version';

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

// Datos de la conexión que hace la petición. Salen SOLO de la petición HTTP, nunca del cuerpo.
export type ContextoPeticion = { ip: string | null; userAgent: string | null };

// IP directa de la conexión. Solo si TRUST_PROXY > 0 (hay un proxy de confianza delante) se aceptan
// CF-Connecting-IP y X-Forwarded-For (esta última la resuelve Express con el número de proxies).
// Sin proxy de confianza esos encabezados se ignoran: cualquiera podría escribirlos y falsear la prueba.
export const contextoDe = (req: Request): ContextoPeticion => {
  const hayProxy = Number(req.app.get('trust proxy')) > 0;
  const cf = hayProxy ? req.get('cf-connecting-ip')?.trim() : undefined;
  const bruta = cf && isIP(cf) ? cf : hayProxy ? req.ip : req.socket.remoteAddress;
  const ip = bruta ? bruta.replace(/^::ffff:/i, '') : null;
  return { ip: ip && isIP(ip) ? ip : null, userAgent: req.get('user-agent')?.slice(0, 500) || null };
};

// Zona del negocio donde se aceptó; la de la plataforma si la aceptación no tiene negocio
const ZONA_DE_ACEPTACION = (empresaId: string) =>
  `COALESCE((SELECT zona_horaria FROM empresas WHERE id = ${empresaId}), '${ZONA_PLATAFORMA}')`;

// Guarda la prueba en auditoria_autorizaciones (solo inserción): quién (cuenta, integrante del equipo o
// teléfono del invitado), cuándo (now(), en UTC), por qué canal, desde dónde y las versiones vigentes
export const registrarAutorizacion = async (
  db: Consultable,
  a: {
    canal: CanalAutorizacion;
    contexto: ContextoPeticion;
    usuarioId?: string | null;
    barberoId?: string | null;
    correo?: string | null;
    telefono?: string | null;
    indicativo?: string | null;
    empresaId?: string | null;
    citaId?: string | null;
  },
) => {
  const { rows } = await db.query<FilaAuditoria>(
    `INSERT INTO auditoria_autorizaciones
       (usuario_id, barbero_id, correo, telefono, indicativo, empresa_id, cita_id, canal,
        version_politica, version_terminos, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${VIGENTE('politica_datos')}, ${VIGENTE('terminos')}, $9, $10)
     RETURNING canal, version_politica, version_terminos, aceptado_en, ${ZONA_DE_ACEPTACION('empresa_id')} AS zona_horaria`,
    [
      a.usuarioId ?? null, a.barberoId ?? null, a.correo ?? null, a.telefono ?? null, a.indicativo ?? null,
      a.empresaId ?? null, a.citaId ?? null, a.canal, a.contexto.ip, a.contexto.userAgent,
    ],
  );
  return aAceptacion(rows[0]!);
};

type FilaAuditoria = { canal: CanalAutorizacion; version_politica: string; version_terminos: string; aceptado_en: Date; zona_horaria: string };
const aAceptacion = (f: FilaAuditoria) => ({
  canal: f.canal,
  versionPolitica: f.version_politica,
  versionTerminos: f.version_terminos,
  aceptadoEn: aIsoEnZona(f.aceptado_en, f.zona_horaria),
  zonaHoraria: f.zona_horaria,
});

// Última aceptación del titular y versiones vigentes. "vigente" = aceptó las dos versiones actuales.
export const estadoAutorizacion = async (db: Consultable, titular: Titular) => {
  const { rows } = await db.query<FilaAuditoria & { vigente_politica: string; vigente_terminos: string }>(
    `SELECT canal, version_politica, version_terminos, aceptado_en, zona_horaria,
            ${VIGENTE('politica_datos')} AS vigente_politica, ${VIGENTE('terminos')} AS vigente_terminos
     FROM (SELECT 1) base
     LEFT JOIN LATERAL (
       SELECT canal, version_politica, version_terminos, aceptado_en, ${ZONA_DE_ACEPTACION('empresa_id')} AS zona_horaria
       FROM auditoria_autorizaciones
       WHERE ($1::varchar IS NOT NULL AND usuario_id = $1) OR ($2::varchar IS NOT NULL AND barbero_id = $2)
       ORDER BY aceptado_en DESC, id DESC LIMIT 1
     ) ultima ON true`,
    [titular.usuarioId, titular.barberoId],
  );
  const f = rows[0]!;
  const aceptada = f.aceptado_en ? aAceptacion(f) : null;
  return {
    vigente: !!aceptada && aceptada.versionPolitica === f.vigente_politica && aceptada.versionTerminos === f.vigente_terminos,
    versionPolitica: f.vigente_politica,
    versionTerminos: f.vigente_terminos,
    ultimaAceptacion: aceptada,
  };
};

// true si la cuenta ya aceptó las versiones vigentes de la política y de los términos
export const tieneAutorizacionVigente = async (db: Consultable, usuarioId: string) =>
  (
    await db.query(
      `SELECT 1 FROM auditoria_autorizaciones
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
export const crearRutasLegal = ({
  pool,
  titularDe,
}: {
  pool: pg.Pool;
  titularDe: (jwt: string | undefined) => Promise<Titular>;
}) => {
  const rutas = Router();

  // Antes de /:documento para que "estado" y "aceptar" no se tomen como un documento.
  // Cualquier sesión (administrador, equipo o cliente): ¿tiene aceptada la versión vigente?
  rutas.get('/estado', async (req, res) => {
    res.json(await estadoAutorizacion(pool, await titularDe(tokenDe(req))));
  });

  // Registra la aceptación de las versiones vigentes como una fila nueva (nunca se edita una anterior).
  // Si ya las tenía aceptadas no agrega otra fila.
  rutas.post('/aceptar', async (req, res) => {
    const titular = await titularDe(tokenDe(req));
    parsear(z.object(aceptacionObligatoria), req.body ?? {});
    const antes = await estadoAutorizacion(pool, titular);
    if (antes.vigente) {
      res.json({ mensaje: 'Ya aceptaste las versiones vigentes', ...antes });
      return;
    }
    await registrarAutorizacion(pool, { canal: 'nueva_version', contexto: contextoDe(req), ...titular });
    res.status(201).json({ mensaje: 'Aceptación registrada', ...(await estadoAutorizacion(pool, titular)) });
  });

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
