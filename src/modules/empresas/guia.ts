import type { Consultable } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import { enlacePublico } from './enlace.js';

// Guía inicial del negocio: 3 pasos para empezar. El primero (tener un servicio) se calcula con los
// servicios activos; los otros dos quedan marcados con su fecha: el horario, cuando la administradora guarda
// "Mi negocio", y el enlace, cuando toca Compartir o Copiar en la app. También puede ocultarla.

type FilaGuia = {
  codigo_acceso: string;
  tiene_servicio: boolean;
  horario_revisado: boolean;
  enlace_compartido: boolean;
  oculta: boolean;
};

const buscarGuia = async (db: Consultable, empresaId: string) =>
  (
    await db.query<FilaGuia>(
      `SELECT e.codigo_acceso,
              EXISTS (SELECT 1 FROM servicios s WHERE s.empresa_id = e.id AND s.activo) AS tiene_servicio,
              e.guia_horario_revisado_en IS NOT NULL AS horario_revisado,
              e.guia_enlace_compartido_en IS NOT NULL AS enlace_compartido,
              e.guia_oculta_en IS NOT NULL AS oculta
       FROM empresas e WHERE e.id = $1`,
      [empresaId],
    )
  ).rows[0];

// Marca un paso con la fecha de la primera vez (las siguientes no la cambian)
const COLUMNAS = {
  horario: 'guia_horario_revisado_en',
  enlace: 'guia_enlace_compartido_en',
} as const;

// Lo llama "Mi negocio" al guardar. No lanza error si la empresa no existe.
export const marcarPaso = (db: Consultable, empresaId: string, paso: keyof typeof COLUMNAS) =>
  db.query(`UPDATE empresas SET ${COLUMNAS[paso]} = coalesce(${COLUMNAS[paso]}, now()) WHERE id = $1`, [empresaId]);

export const crearServicioGuia = ({ pool, enlaceBase }: { pool: Consultable; enlaceBase: string }) => {
  const armar = async (empresaId: string) => {
    const g = await buscarGuia(pool, empresaId);
    if (!g) throw errores.noEncontrado('Establecimiento no encontrado');
    const pasos = [
      { id: 'servicio', titulo: 'Crea tu primer servicio', completado: g.tiene_servicio },
      { id: 'horario', titulo: 'Revisa tu horario de atención', completado: g.horario_revisado },
      { id: 'enlace', titulo: 'Comparte tu enlace con tus clientes', completado: g.enlace_compartido },
    ];
    const completados = pasos.filter((p) => p.completado).length;
    return {
      pasos,
      completados,
      total: pasos.length,
      completa: completados === pasos.length,
      oculta: g.oculta,
      enlacePublico: enlacePublico(enlaceBase, g.codigo_acceso),
    };
  };

  return {
    guia: armar,

    // La app lo llama cuando la administradora toca Compartir o Copiar el enlace
    async marcarEnlaceCompartido(empresaId: string) {
      await marcarPaso(pool, empresaId, 'enlace');
      return armar(empresaId);
    },

    async cambiarOculta(empresaId: string, oculta: boolean) {
      await pool.query('UPDATE empresas SET guia_oculta_en = CASE WHEN $2 THEN coalesce(guia_oculta_en, now()) END WHERE id = $1', [
        empresaId,
        oculta,
      ]);
      return armar(empresaId);
    },
  };
};

export type ServicioGuia = ReturnType<typeof crearServicioGuia>;
