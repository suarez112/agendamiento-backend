import type { Consultable } from '../../db/pool.js';

export type FilaBarberoLogin = {
  id: string;
  empresa_id: string;
  nombre: string;
  usuario: string;
  password_hash: string;
  es_admin: boolean;
  especialidad: string | null;
  porcentaje_ganancia: string;
  foto_url: string | null;
  empresa_nombre: string;
  empresa_codigo: string;
};

export const buscarBarberoPorUsuario = async (db: Consultable, usuario: string) => {
  const { rows } = await db.query<FilaBarberoLogin>(
    `SELECT b.id, b.empresa_id, b.nombre, b.usuario, b.password_hash, b.es_admin,
            b.especialidad, b.porcentaje_ganancia, b.foto_url,
            e.nombre AS empresa_nombre, e.codigo_acceso AS empresa_codigo
     FROM barberos b
     JOIN empresas e ON e.id = b.empresa_id
     WHERE lower(b.usuario) = lower($1)`,
    [usuario],
  );
  return rows[0];
};

export const actualizarHashContrasena = (db: Consultable, barberoId: string, hash: string) =>
  db.query('UPDATE barberos SET password_hash = $2 WHERE id = $1', [barberoId, hash]);

// Rol actual del barbero; undefined si fue eliminado o cambió de negocio
export const buscarRolVigente = async (db: Consultable, barberoId: string, empresaId: string) => {
  const { rows } = await db.query<{ es_admin: boolean }>(
    'SELECT es_admin FROM barberos WHERE id = $1 AND empresa_id = $2',
    [barberoId, empresaId],
  );
  return rows[0];
};
