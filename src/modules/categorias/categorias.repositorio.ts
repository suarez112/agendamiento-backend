import type { Consultable } from '../../db/pool.js';

export type FilaCategoria = { id: string; nombre: string; activa: boolean };

const COLUMNAS = 'id, nombre, activa';

// Solo las activas, o todas (panel del superadmin). Orden alfabético.
export const listarCategorias = async (db: Consultable, soloActivas: boolean) =>
  (
    await db.query<FilaCategoria>(
      `SELECT ${COLUMNAS} FROM categorias_negocio WHERE (NOT $1::boolean OR activa) ORDER BY nombre`,
      [soloActivas],
    )
  ).rows;

// Busca una categoría ACTIVA por nombre (sin distinguir mayúsculas); devuelve el nombre oficial
export const buscarActivaPorNombre = async (db: Consultable, nombre: string) =>
  (
    await db.query<FilaCategoria>(
      `SELECT ${COLUMNAS} FROM categorias_negocio WHERE lower(nombre) = lower($1) AND activa`,
      [nombre],
    )
  ).rows[0];

// undefined si ya existe una con ese nombre (sin distinguir mayúsculas)
export const crearCategoria = async (db: Consultable, nombre: string) =>
  (
    await db.query<FilaCategoria>(
      `INSERT INTO categorias_negocio (nombre) VALUES ($1)
       ON CONFLICT (lower(nombre)) DO NOTHING RETURNING ${COLUMNAS}`,
      [nombre],
    )
  ).rows[0];

export const buscarCategoria = async (db: Consultable, id: string) =>
  (await db.query<FilaCategoria>(`SELECT ${COLUMNAS} FROM categorias_negocio WHERE id = $1 FOR UPDATE`, [id])).rows[0];

// Cambia el nombre y/o el estado. Lanza el error de índice único si el nombre ya lo usa otra.
export const actualizarCategoria = async (db: Consultable, id: string, c: { nombre?: string; activa?: boolean }) =>
  (
    await db.query<FilaCategoria>(
      `UPDATE categorias_negocio SET nombre = COALESCE($2, nombre), activa = COALESCE($3, activa)
       WHERE id = $1 RETURNING ${COLUMNAS}`,
      [id, c.nombre ?? null, c.activa ?? null],
    )
  ).rows[0];
