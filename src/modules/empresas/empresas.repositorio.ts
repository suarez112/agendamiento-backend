import type { Consultable } from '../../db/pool.js';

export type FilaEmpresa = {
  id: string;
  nombre: string;
  codigo_acceso: string;
  color_primario: string | null;
  color_secundario: string | null;
  horario_apertura: string;
  horario_cierre: string;
};

const COLUMNAS_EMPRESA = `id, nombre, codigo_acceso, color_primario, color_secundario,
                          horario_apertura, horario_cierre`;

export const buscarEmpresaPorCodigo = async (db: Consultable, codigo: string) =>
  (
    await db.query<FilaEmpresa>(
      `SELECT ${COLUMNAS_EMPRESA} FROM empresas WHERE codigo_acceso = $1`,
      [codigo],
    )
  ).rows[0];

export const buscarEmpresaPorId = async (db: Consultable, id: string) =>
  (await db.query<FilaEmpresa>(`SELECT ${COLUMNAS_EMPRESA} FROM empresas WHERE id = $1`, [id]))
    .rows[0];

export type FilaBarbero = {
  id: string;
  nombre: string;
  usuario: string;
  es_admin: boolean;
  especialidad: string | null;
  porcentaje_ganancia: string;
  foto_url: string | null;
};

export const listarBarberos = async (db: Consultable, empresaId: string) =>
  (
    await db.query<FilaBarbero>(
      `SELECT id, nombre, usuario, es_admin, especialidad, porcentaje_ganancia, foto_url
       FROM barberos WHERE empresa_id = $1`,
      [empresaId],
    )
  ).rows;

export type FilaServicio = { id: string; nombre: string; duracion_min: number; precio: string };

export const listarServicios = async (db: Consultable, empresaId: string) =>
  (
    await db.query<FilaServicio>(
      'SELECT id, nombre, duracion_min, precio FROM servicios WHERE empresa_id = $1',
      [empresaId],
    )
  ).rows;
