import type { Consultable } from '../../db/pool.js';

export type FilaEmpresa = {
  id: string;
  nombre: string;
  codigo_acceso: string;
  color_primario: string | null;
  color_secundario: string | null;
  zona_horaria: string;
  whatsapp_contacto: string | null;
  anticipacion_cancelacion_horas: number;
};

const COLUMNAS_EMPRESA =
  'id, nombre, codigo_acceso, color_primario, color_secundario, zona_horaria, whatsapp_contacto, anticipacion_cancelacion_horas';

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
  atiende_clientes: boolean;
};

export const listarBarberos = async (db: Consultable, empresaId: string) =>
  (
    await db.query<FilaBarbero>(
      `SELECT id, nombre, usuario, es_admin, especialidad, porcentaje_ganancia, foto_url, atiende_clientes
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
  direccion: string | null;
  departamento: string | null;
  ciudad: string | null;
  nombre_administradora: string | null;
  numero_empleados: number | null;
  logo_url: string | null;
  foto_url: string | null;
  color_primario: string | null;
  color_secundario: string | null;
  // numeric: llegan como texto
  latitud: string | null;
  longitud: string | null;
  precision_ubicacion: string | null;
  estado_suscripcion: string;
  trial_ends_at: Date | null;
  created_at: Date | null;
  intervalo_minutos: number;
  pais: string;
  zona_horaria: string;
  whatsapp_contacto: string | null;
  anticipacion_cancelacion_horas: number;
};

const COLUMNAS_PERFIL = `id, nombre, codigo_acceso, categoria, direccion, departamento, ciudad,
                         nombre_administradora, numero_empleados, logo_url, foto_url, color_primario, color_secundario,
                         latitud, longitud, precision_ubicacion, estado_suscripcion, trial_ends_at, created_at,
                         intervalo_minutos, pais, zona_horaria, whatsapp_contacto, anticipacion_cancelacion_horas`;

export const buscarPerfilEmpresa = async (db: Consultable, id: string) =>
  (await db.query<FilaPerfilEmpresa>(`SELECT ${COLUMNAS_PERFIL} FROM empresas WHERE id = $1`, [id])).rows[0];

// Zona horaria IANA del negocio; undefined si no existe
export const buscarZonaHoraria = async (db: Consultable, empresaId: string) =>
  (await db.query<{ zona_horaria: string }>('SELECT zona_horaria FROM empresas WHERE id = $1', [empresaId])).rows[0]
    ?.zona_horaria;

// Citas confirmadas que aún no empezaron (hora de pared de la zona actual del negocio). Se guardan como
// fecha y hora locales, así que cambiar la zona las movería de instante.
export const contarCitasPendientes = async (db: Consultable, empresaId: string) =>
  (
    await db.query<{ total: number }>(
      `SELECT count(*)::int AS total
       FROM citas c JOIN empresas e ON e.id = c.empresa_id
       WHERE c.empresa_id = $1 AND c.estado = 'CONFIRMADA'
         AND (c.fecha + c.hora_inicio) AT TIME ZONE e.zona_horaria > now()`,
      [empresaId],
    )
  ).rows[0].total;

// Cada cuántos minutos pueden agendar los clientes (10, 20, 30, 40, 50 o 60)
export const buscarIntervalo = async (db: Consultable, empresaId: string) =>
  (await db.query<{ intervalo_minutos: number }>('SELECT intervalo_minutos FROM empresas WHERE id = $1', [empresaId]))
    .rows[0]?.intervalo_minutos;

export const cambiarIntervalo = async (db: Consultable, empresaId: string, minutos: number) =>
  (
    await db.query<{ intervalo_minutos: number }>(
      'UPDATE empresas SET intervalo_minutos = $2 WHERE id = $1 RETURNING intervalo_minutos',
      [empresaId, minutos],
    )
  ).rows[0]?.intervalo_minutos;

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
  codigoAcceso: 'codigo_acceso',
  direccion: 'direccion',
  departamento: 'departamento',
  ciudad: 'ciudad',
  nombreAdministradora: 'nombre_administradora',
  numeroEmpleados: 'numero_empleados',
  logoUrl: 'logo_url',
  latitud: 'latitud',
  longitud: 'longitud',
  precisionUbicacion: 'precision_ubicacion',
  zonaHoraria: 'zona_horaria',
  whatsappContacto: 'whatsapp_contacto',
  anticipacionCancelacionHoras: 'anticipacion_cancelacion_horas',
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

// true si ningún negocio usa ese código (los códigos se guardan en mayúsculas)
export const codigoDisponible = async (db: Consultable, codigo: string) =>
  (await db.query('SELECT 1 FROM empresas WHERE codigo_acceso = $1', [codigo])).rowCount === 0;

export type FilaSuscripcion = {
  estado_suscripcion: string;
  trial_ends_at: Date | null;
  plan: 'mensual' | 'anual' | null;
  // AAAA-MM-DD, en la zona horaria del negocio
  fecha_pago: string | null;
  fecha_fin: string | null;
  // Fecha de fin menos hoy: 0 o negativo = vencida. null si no tiene fecha de fin.
  dias_restantes: number | null;
  // Días de prueba que quedaban al pagar durante la prueba y se sumaron al plan
  dias_prueba_sumados: number | null;
  // Un negocio suspendido por soporte no está habilitado, aunque su plan siga vigente
  suspendida: boolean;
  habilitada: boolean;
  // Nivel (emprendedor | equipo | pro) y profesionales que atienden clientes (cobrados / ya pagados en el periodo)
  plan_equipo: string;
  profesionales_cobrados: number;
  profesionales_pagados: number;
  // Día del registro de la empresa (AAAA-MM-DD, zona del negocio); null en empresas muy antiguas
  fecha_registro: string | null;
  zona_horaria: string;
};

// Estado de la suscripción con la fecha actual en la zona del negocio, así los días que
// quedan bajan cada día. La prueba termina el día de trial_ends_at y un plan el
// día de suscripcion_fin: ese día ya no queda ninguno. No hace falta una tarea
// programada que marque las vencidas: se calcula en cada consulta.
// Una empresa 'activa' sin fecha de fin (anterior a los planes) sigue habilitada.
export const buscarSuscripcion = async (db: Consultable, empresaId: string) =>
  (
    await db.query<FilaSuscripcion>(
      `SELECT estado_suscripcion, trial_ends_at, plan_suscripcion AS plan,
              to_char(fecha_pago, 'YYYY-MM-DD') AS fecha_pago,
              to_char(fin, 'YYYY-MM-DD') AS fecha_fin,
              fin - hoy AS dias_restantes, dias_prueba_sumados,
              suspendida,
              NOT suspendida AND estado_suscripcion IN ('trial', 'activa') AND (fin IS NULL OR fin > hoy) AS habilitada,
              plan_equipo, profesionales_cobrados, profesionales_pagados, to_char(registro, 'YYYY-MM-DD') AS fecha_registro, zona_horaria
       FROM (
         SELECT estado_suscripcion, trial_ends_at, plan_suscripcion, fecha_pago, dias_prueba_sumados, plan_equipo, zona_horaria,
                profesionales_pagados,
                suspendida_en IS NOT NULL AS suspendida,
                (SELECT count(*)::int FROM barberos b WHERE b.empresa_id = empresas.id AND b.activo AND b.atiende_clientes) AS profesionales_cobrados,
                (created_at AT TIME ZONE zona_horaria)::date AS registro,
                CASE estado_suscripcion
                  WHEN 'trial' THEN (trial_ends_at AT TIME ZONE zona_horaria)::date
                  WHEN 'activa' THEN suscripcion_fin
                END AS fin,
                (now() AT TIME ZONE zona_horaria)::date AS hoy
         FROM empresas WHERE id = $1
       ) s`,
      [empresaId],
    )
  ).rows[0];
