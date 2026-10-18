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
       FROM barberos WHERE empresa_id = $1 AND activo`,
      [empresaId],
    )
  ).rows;

export type FilaServicio = { id: string; nombre: string; duracion_min: number; precio: string };

export const listarServicios = async (db: Consultable, empresaId: string) =>
  (
    await db.query<FilaServicio>(
      'SELECT id, nombre, duracion_min, precio FROM servicios WHERE empresa_id = $1 AND activo',
      [empresaId],
    )
  ).rows;

// Perfil completo para el administrador de la empresa
export type FilaPerfilEmpresa = {
  id: string;
  nombre: string;
  codigo_acceso: string;
  categoria: string | null;
  nit: string | null;
  telefono: string | null;
  correo: string | null;
  direccion: string | null;
  ciudad: string | null;
  dias_atencion: number[] | null;
  horario_apertura: string;
  horario_cierre: string;
  nombre_administradora: string | null;
  numero_empleados: number | null;
  logo_url: string | null;
  foto_url: string | null;
  color_primario: string | null;
  color_secundario: string | null;
  estado_suscripcion: string;
  trial_ends_at: Date | null;
  created_at: Date | null;
};

const COLUMNAS_PERFIL = `id, nombre, codigo_acceso, categoria, nit, telefono, correo, direccion, ciudad,
                         dias_atencion, horario_apertura, horario_cierre, nombre_administradora,
                         numero_empleados, logo_url, foto_url, color_primario, color_secundario,
                         estado_suscripcion, trial_ends_at, created_at`;

export const buscarPerfilEmpresa = async (db: Consultable, id: string) =>
  (await db.query<FilaPerfilEmpresa>(`SELECT ${COLUMNAS_PERFIL} FROM empresas WHERE id = $1`, [id])).rows[0];

// Vista pública del negocio: los clientes la buscan con el código de acceso
export const buscarPerfilEmpresaPorCodigo = async (db: Consultable, codigo: string) =>
  (
    await db.query<FilaPerfilEmpresa>(`SELECT ${COLUMNAS_PERFIL} FROM empresas WHERE codigo_acceso = $1`, [
      codigo,
    ])
  ).rows[0];

// Cambia la foto y devuelve la ruta de la anterior para poder borrar su archivo.
// FOR UPDATE hace que dos cambios a la vez se esperen y cada uno vea la foto que reemplaza.
export const cambiarFotoEmpresa = async (db: Consultable, id: string, fotoUrl: string) =>
  (
    await db.query<{ foto_anterior: string | null }>(
      `UPDATE empresas e SET foto_url = $2
       FROM (SELECT id, foto_url FROM empresas WHERE id = $1 FOR UPDATE) anterior
       WHERE e.id = anterior.id
       RETURNING anterior.foto_url AS foto_anterior`,
      [id, fotoUrl],
    )
  ).rows[0];

// Campo de la API → columna. Solo estas columnas se pueden editar; los nombres
// de columna nunca vienen del usuario, los valores siempre van como parámetros.
const COLUMNA_EDITABLE = {
  nombre: 'nombre',
  categoria: 'categoria',
  nit: 'nit',
  telefono: 'telefono',
  correo: 'correo',
  direccion: 'direccion',
  ciudad: 'ciudad',
  diasAtencion: 'dias_atencion',
  horarioApertura: 'horario_apertura',
  horarioCierre: 'horario_cierre',
  nombreAdministradora: 'nombre_administradora',
  numeroEmpleados: 'numero_empleados',
  logoUrl: 'logo_url',
} as const;

export type CambiosPerfil = Partial<Record<keyof typeof COLUMNA_EDITABLE, unknown>>;

export const actualizarPerfilEmpresa = async (db: Consultable, id: string, cambios: CambiosPerfil) => {
  const columnas: string[] = [];
  const valores: unknown[] = [id];
  for (const [campo, columna] of Object.entries(COLUMNA_EDITABLE)) {
    const valor = cambios[campo as keyof CambiosPerfil];
    if (valor === undefined) continue;
    valores.push(valor);
    columnas.push(`${columna} = $${valores.length}`);
  }
  if (columnas.length === 0) return buscarPerfilEmpresa(db, id);
  return (
    await db.query<FilaPerfilEmpresa>(
      `UPDATE empresas SET ${columnas.join(', ')} WHERE id = $1 RETURNING ${COLUMNAS_PERFIL}`,
      valores,
    )
  ).rows[0];
};

export type FilaSuscripcion = {
  estado_suscripcion: string;
  trial_ends_at: Date | null;
  dias_restantes: number | null;
  habilitada: boolean;
};

// Estado de la suscripción calculado con el reloj de la base. Los días que
// quedan se redondean hacia arriba (quedan 2 horas = 1 día) y nunca son negativos.
export const buscarSuscripcion = async (db: Consultable, empresaId: string) =>
  (
    await db.query<FilaSuscripcion>(
      `SELECT estado_suscripcion, trial_ends_at,
              CASE WHEN estado_suscripcion = 'trial'
                   THEN GREATEST(0, ceil(extract(epoch FROM trial_ends_at - now()) / 86400))::int
              END AS dias_restantes,
              (estado_suscripcion = 'activa'
               OR (estado_suscripcion = 'trial' AND trial_ends_at > now())) AS habilitada
       FROM empresas WHERE id = $1`,
      [empresaId],
    )
  ).rows[0];
