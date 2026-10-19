import type { Consultable } from '../../db/pool.js';
import type { PerfilEmpresa } from '../empresas/empresas.esquemas.js';

export type Rol = 'admin' | 'cliente';

export type FilaUsuario = { id: string; correo: string; usuario: string | null; rol: Rol; empresa_id: string | null };

const COLUMNAS_USUARIO = 'id, correo, usuario, rol, empresa_id';

export type FilaEmpresaRegistrada = {
  id: string;
  nombre: string;
  codigo_acceso: string;
  estado_suscripcion: string;
  trial_ends_at: Date;
};

// Inserta la empresa en periodo de prueba (el horario se guarda aparte).
// Devuelve undefined si otro negocio ya tiene ese código de acceso.
export const insertarEmpresaEnPrueba = async (
  db: Consultable,
  perfil: Omit<PerfilEmpresa, 'horario'>,
  diasPrueba: number,
) =>
  (
    await db.query<FilaEmpresaRegistrada>(
      `INSERT INTO empresas (id, nombre, codigo_acceso, categoria, direccion, departamento, ciudad,
         nombre_administradora, numero_empleados, logo_url, estado_suscripcion, trial_ends_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9,
         'trial', now() + make_interval(days => $10))
       ON CONFLICT (codigo_acceso) DO NOTHING
       RETURNING id, nombre, codigo_acceso, estado_suscripcion, trial_ends_at`,
      [
        perfil.nombre,
        perfil.codigoAcceso,
        perfil.categoria,
        perfil.direccion,
        perfil.departamento,
        perfil.ciudad,
        perfil.nombreAdministradora,
        perfil.numeroEmpleados,
        perfil.logoUrl ?? null,
        diasPrueba,
      ],
    )
  ).rows[0];

export const insertarUsuario = async (
  db: Consultable,
  datos: { correo: string; usuario: string | null; passwordHash: string; rol: Rol; empresaId: string | null },
) =>
  (
    await db.query<FilaUsuario>(
      `INSERT INTO usuarios (correo, usuario, password_hash, rol, empresa_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNAS_USUARIO}`,
      [datos.correo, datos.usuario, datos.passwordHash, datos.rol, datos.empresaId],
    )
  ).rows[0];

export const buscarUsuarioPorCorreo = async (db: Consultable, correo: string) =>
  (
    await db.query<FilaUsuario & { password_hash: string }>(
      `SELECT ${COLUMNAS_USUARIO}, password_hash FROM usuarios WHERE lower(correo) = lower($1)`,
      [correo],
    )
  ).rows[0];

// El usuario no distingue mayúsculas (índice usuarios_usuario_lower_key)
export const buscarUsuarioPorNombreDeUsuario = async (db: Consultable, usuario: string) =>
  (
    await db.query<FilaUsuario & { password_hash: string }>(
      `SELECT ${COLUMNAS_USUARIO}, password_hash FROM usuarios WHERE lower(usuario) = lower($1)`,
      [usuario],
    )
  ).rows[0];

// Rol y empresa vigentes; undefined si la cuenta fue eliminada
export const buscarUsuarioPorId = async (db: Consultable, id: string) =>
  (await db.query<FilaUsuario>(`SELECT ${COLUMNAS_USUARIO} FROM usuarios WHERE id = $1`, [id])).rows[0];
