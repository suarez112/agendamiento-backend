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
  atiende_clientes: boolean;
  empresa_nombre: string;
  empresa_codigo: string;
  version_sesion: number;
};

export const buscarBarberoPorUsuario = async (db: Consultable, usuario: string) => {
  const { rows } = await db.query<FilaBarberoLogin>(
    `SELECT b.id, b.empresa_id, b.nombre, b.usuario, b.password_hash, b.es_admin,
            b.especialidad, b.porcentaje_ganancia, b.foto_url, b.atiende_clientes, b.version_sesion,
            e.nombre AS empresa_nombre, e.codigo_acceso AS empresa_codigo
     FROM barberos b
     JOIN empresas e ON e.id = b.empresa_id
     WHERE lower(b.usuario) = lower($1) AND b.activo`,
    [usuario],
  );
  return rows[0];
};

export const actualizarHashContrasena = (db: Consultable, barberoId: string, hash: string) =>
  db.query('UPDATE barberos SET password_hash = $2 WHERE id = $1', [barberoId, hash]);

// Rol y versión de sesión actuales del barbero; undefined si fue eliminado o cambió de negocio
export const buscarRolVigente = async (db: Consultable, barberoId: string, empresaId: string) => {
  const { rows } = await db.query<{ es_admin: boolean; version_sesion: number }>(
    'SELECT es_admin, version_sesion FROM barberos WHERE id = $1 AND empresa_id = $2 AND activo',
    [barberoId, empresaId],
  );
  return rows[0];
};

// Rol y empresa actuales de una cuenta (tabla usuarios); undefined si ya no existe
export const buscarCuentaVigente = async (db: Consultable, usuarioId: string) => {
  const { rows } = await db.query<{ rol: string; empresa_id: string | null; version_sesion: number }>(
    'SELECT rol, empresa_id, version_sesion FROM usuarios WHERE id = $1',
    [usuarioId],
  );
  return rows[0];
};

// Cierre de sesión en el servidor: sube la versión (todos los tokens anteriores del personal dejan de servir)
// y borra sus celulares registrados para notificaciones push
export const cerrarSesionPersonal = async (db: Consultable, barberoId: string) => {
  await db.query('UPDATE barberos SET version_sesion = version_sesion + 1 WHERE id = $1', [barberoId]);
  await db.query('DELETE FROM dispositivos_push WHERE barbero_id = $1', [barberoId]);
};

// Lo mismo para una cuenta (administradora o cliente)
export const cerrarSesionCuenta = async (db: Consultable, usuarioId: string) => {
  await db.query('UPDATE usuarios SET version_sesion = version_sesion + 1 WHERE id = $1', [usuarioId]);
  await db.query('DELETE FROM dispositivos_push WHERE usuario_id = $1', [usuarioId]);
};
