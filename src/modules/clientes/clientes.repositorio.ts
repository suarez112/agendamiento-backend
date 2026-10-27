import type { Consultable } from '../../db/pool.js';

// La lista negra compara solo los dígitos del teléfono ("300 123-4567" = "3001234567"),
// igual que la comprobación al reservar (citas.repositorio.telefonoEnListaNegra)
const MISMO_TELEFONO = (a: string, b: string) =>
  `regexp_replace(${a}, '[^0-9]', '', 'g') = regexp_replace(${b}, '[^0-9]', '', 'g')`;

export type FilaCliente = {
  id: string;
  nombre: string;
  telefono: string;
  indicativo: string;
  total_citas: number;
  fecha_ultima_cita: string | null;
  lista_negra_id: string | null;
  citas_completadas: number;
  citas_canceladas: number;
  activo: boolean;
};

// Días hacia atrás que cuenta una cita para que el cliente siga "activo"
export const DIAS_CLIENTE_ACTIVO = 45;

// Activo: tiene una cita no cancelada desde hace 45 días (fecha en la zona del negocio) en
// adelante. Eso incluye una visita de hoy y cualquier cita próxima.
const COLUMNAS_CLIENTE = `c.id, c.nombre, c.telefono, c.indicativo, c.total_citas,
  to_char(c.fecha_ultima_cita, 'YYYY-MM-DD') AS fecha_ultima_cita,
  (SELECT ln.id FROM lista_negra ln
   WHERE ln.empresa_id = c.empresa_id AND ${MISMO_TELEFONO('ln.telefono', 'c.telefono')}
   LIMIT 1) AS lista_negra_id,
  est.citas_completadas, est.citas_canceladas, est.activo`;

const DESDE_CLIENTES = `FROM clientes c
  JOIN empresas em ON em.id = c.empresa_id
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE ci.estado = 'COMPLETADA')::int AS citas_completadas,
           count(*) FILTER (WHERE ci.estado = 'CANCELADA')::int AS citas_canceladas,
           coalesce(bool_or(ci.estado <> 'CANCELADA'
             AND ci.fecha >= (now() AT TIME ZONE em.zona_horaria)::date - ${DIAS_CLIENTE_ACTIVO}), false) AS activo
    FROM citas ci WHERE ci.cliente_id = c.id AND ci.empresa_id = c.empresa_id
  ) est`;

export const listarClientes = async (db: Consultable, empresaId: string) =>
  (
    await db.query<FilaCliente>(
      `SELECT ${COLUMNAS_CLIENTE} ${DESDE_CLIENTES}
       WHERE c.empresa_id = $1
       ORDER BY c.fecha_ultima_cita DESC NULLS LAST, c.nombre`,
      [empresaId],
    )
  ).rows;

export const buscarCliente = async (db: Consultable, id: string, empresaId: string) =>
  (
    await db.query<FilaCliente>(`SELECT ${COLUMNAS_CLIENTE} ${DESDE_CLIENTES} WHERE c.id = $1 AND c.empresa_id = $2`, [
      id,
      empresaId,
    ])
  ).rows[0];

export type FilaCitaCliente = {
  id: string;
  fecha: string;
  hora: string;
  servicio: string;
  barbero_id: string;
  barbero_nombre: string;
  precio: string;
  estado: string;
};

// Todas las citas del cliente en el negocio, de la más reciente a la más antigua
export const listarCitasCliente = async (db: Consultable, clienteId: string, empresaId: string) =>
  (
    await db.query<FilaCitaCliente>(
      `SELECT c.id, to_char(c.fecha, 'YYYY-MM-DD') AS fecha, to_char(c.hora_inicio, 'HH12:MI AM') AS hora,
              s.nombre AS servicio, c.barbero_id, b.nombre AS barbero_nombre, c.precio, c.estado
       FROM citas c
       JOIN servicios s ON s.id = c.servicio_id
       JOIN barberos b ON b.id = c.barbero_id
       WHERE c.cliente_id = $1 AND c.empresa_id = $2
       ORDER BY c.fecha DESC, c.hora_inicio DESC`,
      [clienteId, empresaId],
    )
  ).rows;

export type FilaListaNegra = { id: string; nombre: string; telefono: string; agregado_en: Date };

export const listarListaNegra = async (db: Consultable, empresaId: string) =>
  (
    await db.query<FilaListaNegra>(
      `SELECT id, nombre, telefono, created_at AS agregado_en FROM lista_negra
       WHERE empresa_id = $1 ORDER BY created_at DESC`,
      [empresaId],
    )
  ).rows;

// Agrega al cliente con su nombre y teléfono. undefined si ese teléfono ya estaba.
export const agregarAListaNegra = async (db: Consultable, cliente: { empresaId: string; nombre: string; telefono: string }) =>
  (
    await db.query<FilaListaNegra>(
      `INSERT INTO lista_negra (empresa_id, nombre, telefono)
       SELECT $1::varchar, $2::varchar, $3::varchar
       WHERE NOT EXISTS (
         SELECT 1 FROM lista_negra WHERE empresa_id = $1 AND ${MISMO_TELEFONO('telefono', '$3')}
       )
       ON CONFLICT (empresa_id, telefono) DO NOTHING
       RETURNING id, nombre, telefono, created_at AS agregado_en`,
      [cliente.empresaId, cliente.nombre, cliente.telefono],
    )
  ).rows[0];

export const quitarDeListaNegra = async (db: Consultable, id: string, empresaId: string) =>
  ((await db.query('DELETE FROM lista_negra WHERE id = $1 AND empresa_id = $2', [id, empresaId])).rowCount ?? 0) > 0;
