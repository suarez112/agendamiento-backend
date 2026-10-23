import type { Consultable } from '../../db/pool.js';

// Sin password_hash: nunca sale de la base hacia la API
export type FilaMiembro = {
  id: string;
  nombre: string;
  usuario: string;
  es_admin: boolean;
  especialidad: string | null;
  porcentaje_ganancia: string;
  foto_url: string | null;
  atiende_clientes: boolean;
};

const COLUMNAS = 'id, nombre, usuario, es_admin, especialidad, porcentaje_ganancia, foto_url, atiende_clientes';

// Solo el equipo activo; quienes fueron eliminados se conservan para las citas pasadas
export const listarEquipo = async (db: Consultable, empresaId: string) =>
  (
    await db.query<FilaMiembro>(
      `SELECT ${COLUMNAS} FROM barberos WHERE empresa_id = $1 AND activo ORDER BY nombre`,
      [empresaId],
    )
  ).rows;

export const crearMiembro = async (
  db: Consultable,
  m: {
    id: string;
    empresaId: string;
    nombre: string;
    usuario: string;
    passwordHash: string;
    esAdmin: boolean;
    atiendeClientes: boolean;
    especialidad: string | null;
    porcentajeGanancia: number;
  },
) =>
  (
    await db.query<FilaMiembro>(
      `INSERT INTO barberos (id, empresa_id, nombre, usuario, password_hash, es_admin, atiende_clientes,
         especialidad, porcentaje_ganancia)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLUMNAS}`,
      [
        m.id,
        m.empresaId,
        m.nombre,
        m.usuario,
        m.passwordHash,
        m.esAdmin,
        m.atiendeClientes,
        m.especialidad,
        m.porcentajeGanancia,
      ],
    )
  ).rows[0];

export type CambiosMiembro = {
  nombre?: string;
  usuario?: string;
  passwordHash?: string;
  esAdmin?: boolean;
  atiendeClientes?: boolean;
  especialidad?: string | null;
  porcentajeGanancia?: number;
};

// Solo cambia los campos enviados. especialidad: undefined = no cambia, null = se borra.
export const actualizarMiembro = async (db: Consultable, id: string, empresaId: string, c: CambiosMiembro) =>
  (
    await db.query<FilaMiembro>(
      `UPDATE barberos
       SET nombre = COALESCE($3, nombre),
           usuario = COALESCE($4, usuario),
           password_hash = COALESCE($5, password_hash),
           es_admin = COALESCE($6, es_admin),
           especialidad = CASE WHEN $7::boolean THEN $8::varchar ELSE especialidad END,
           porcentaje_ganancia = COALESCE($9, porcentaje_ganancia),
           atiende_clientes = COALESCE($10, atiende_clientes)
       WHERE id = $1 AND empresa_id = $2 AND activo
       RETURNING ${COLUMNAS}`,
      [
        id,
        empresaId,
        c.nombre ?? null,
        c.usuario ?? null,
        c.passwordHash ?? null,
        c.esAdmin ?? null,
        c.especialidad !== undefined,
        c.especialidad ?? null,
        c.porcentajeGanancia ?? null,
        c.atiendeClientes ?? null,
      ],
    )
  ).rows[0];

// Límite del equipo: plan de la empresa (su cupo está en src/config/planes.ts) e
// integrantes activos. FOR UPDATE bloquea la empresa: dos altas a la vez se esperan
// y la segunda ve a la primera.
export const bloquearLimiteEquipo = async (db: Consultable, empresaId: string) =>
  (
    await db.query<{ plan: string; activos: number }>(
      `SELECT e.plan_equipo AS plan,
              (SELECT count(*)::int FROM barberos b WHERE b.empresa_id = e.id AND b.activo) AS activos
       FROM empresas e WHERE e.id = $1
       FOR UPDATE`,
      [empresaId],
    )
  ).rows[0];

// Citas confirmadas desde hoy: si tiene alguna, no se puede eliminar
export const contarCitasPendientes = async (db: Consultable, id: string, empresaId: string) =>
  (
    await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM citas
       WHERE barbero_id = $1 AND empresa_id = $2 AND estado = 'CONFIRMADA' AND fecha >= (now() AT TIME ZONE (SELECT zona_horaria FROM empresas WHERE id = $2))::date`,
      [id, empresaId],
    )
  ).rows[0].total;

// Borrado lógico: ya no inicia sesión ni recibe reservas, pero sus citas pasadas
// y la cartera siguen mostrando su nombre. Devuelve su foto para borrar el archivo.
export const desactivarMiembro = async (db: Consultable, id: string, empresaId: string) =>
  (
    await db.query<{ foto_url: string | null }>(
      `UPDATE barberos b SET activo = false, foto_url = NULL
       FROM (SELECT id, foto_url FROM barberos WHERE id = $1 AND empresa_id = $2 AND activo FOR UPDATE) anterior
       WHERE b.id = anterior.id
       RETURNING anterior.foto_url`,
      [id, empresaId],
    )
  ).rows[0];

// Cambia la foto y devuelve la anterior para borrar el archivo
export const cambiarFotoMiembro = async (db: Consultable, id: string, empresaId: string, fotoUrl: string) =>
  (
    await db.query<{ foto_anterior: string | null }>(
      `UPDATE barberos b SET foto_url = $3
       FROM (SELECT id, foto_url FROM barberos WHERE id = $1 AND empresa_id = $2 AND activo FOR UPDATE) anterior
       WHERE b.id = anterior.id
       RETURNING anterior.foto_url AS foto_anterior`,
      [id, empresaId, fotoUrl],
    )
  ).rows[0];
