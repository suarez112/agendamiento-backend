import type { Consultable } from '../../db/pool.js';
import type { PerfilEmpresa } from '../empresas/empresas.esquemas.js';

export type Rol = 'admin' | 'cliente';

// Administradora: correo y usuario. Cliente: correo o usuario, y nombre y teléfono para reservar.
export type FilaUsuario = {
  id: string;
  correo: string | null;
  usuario: string | null;
  rol: Rol;
  empresa_id: string | null;
  nombre: string | null;
  telefono: string | null;
  indicativo: string | null;
  // Sube al cambiar la contraseña: invalida los tokens anteriores
  version_sesion: number;
};

const COLUMNAS_USUARIO = 'id, correo, usuario, rol, empresa_id, nombre, telefono, indicativo, version_sesion';

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
  datos: {
    correo: string | null;
    usuario: string | null;
    passwordHash: string;
    rol: Rol;
    empresaId: string | null;
    nombre?: string | null;
    telefono?: string | null;
    indicativo?: string | null;
  },
) =>
  (
    await db.query<FilaUsuario>(
      `INSERT INTO usuarios (correo, usuario, password_hash, rol, empresa_id, nombre, telefono, indicativo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLUMNAS_USUARIO}`,
      [
        datos.correo,
        datos.usuario,
        datos.passwordHash,
        datos.rol,
        datos.empresaId,
        datos.nombre ?? null,
        datos.telefono ?? null,
        datos.indicativo ?? null,
      ],
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

// --- Recuperar contraseña ---

// Deja a la cuenta con un solo código: el nuevo reemplaza a los anteriores.
// Llamar dentro de una transacción.
export const guardarCodigoRecuperacion = async (
  db: Consultable,
  p: { usuarioId: string; codigoHash: string; minutos: number },
) => {
  await db.query('DELETE FROM codigos_recuperacion WHERE usuario_id = $1', [p.usuarioId]);
  await db.query(
    `INSERT INTO codigos_recuperacion (usuario_id, codigo_hash, vence_en)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [p.usuarioId, p.codigoHash, p.minutos],
  );
};

// Código que todavía sirve (sin usar, sin vencer y sin bloquear), bloqueado para
// esta transacción: dos intentos a la vez se esperan y cuentan bien los fallos.
export const buscarCodigoVigente = async (db: Consultable, usuarioId: string, maxIntentos: number) =>
  (
    await db.query<{ id: string; codigo_hash: string }>(
      `SELECT id, codigo_hash FROM codigos_recuperacion
       WHERE usuario_id = $1 AND usado_en IS NULL AND vence_en > now() AND intentos < $2
       ORDER BY creado_en DESC LIMIT 1
       FOR UPDATE`,
      [usuarioId, maxIntentos],
    )
  ).rows[0];

export const sumarIntentoFallido = (db: Consultable, id: string) =>
  db.query('UPDATE codigos_recuperacion SET intentos = intentos + 1 WHERE id = $1', [id]);

export const marcarCodigoUsado = (db: Consultable, id: string) =>
  db.query('UPDATE codigos_recuperacion SET usado_en = now() WHERE id = $1', [id]);

// Cambia la contraseña y sube la versión de sesión: los tokens anteriores dejan de servir
export const cambiarContrasena = (db: Consultable, usuarioId: string, passwordHash: string) =>
  db.query('UPDATE usuarios SET password_hash = $2, version_sesion = version_sesion + 1 WHERE id = $1', [
    usuarioId,
    passwordHash,
  ]);

// Rol y empresa vigentes; undefined si la cuenta fue eliminada
export const buscarUsuarioPorId = async (db: Consultable, id: string) =>
  (await db.query<FilaUsuario>(`SELECT ${COLUMNAS_USUARIO} FROM usuarios WHERE id = $1`, [id])).rows[0];
