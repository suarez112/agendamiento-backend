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

// Posición del último cliente de una página: mismo orden que la lista completa, con el id como desempate
export type PosicionCliente = { fecha: string | null; nombre: string; id: string };

// Posición de un cliente del negocio en el orden de la lista (para seguir la paginación desde él)
export const buscarPosicionCliente = async (db: Consultable, empresaId: string, id: string) =>
  (
    await db.query<PosicionCliente>(
      `SELECT to_char(fecha_ultima_cita, 'YYYY-MM-DD') AS fecha, nombre, id FROM clientes WHERE id = $1 AND empresa_id = $2`,
      [id, empresaId],
    )
  ).rows[0];

// Escapa los comodines de LIKE para buscar el texto tal cual ("100%" no trae a todos)
const textoLiteral = (texto: string) => texto.replace(/[\\%_]/g, (c) => `\\${c}`);

// Búsqueda por nombre (sin distinguir mayúsculas) y, si se permite y el texto parece un número ("300 123-4567",
// "+57 300"), también por los dígitos del teléfono: así "100%" o "Sala 2" buscan solo en el nombre.
// porTelefono = null: solo por nombre; si no, cuántos dígitos hacen falta como mínimo para buscar en el teléfono y,
// opcionalmente (soloSi), una condición SQL que limita la búsqueda por teléfono a ciertos clientes.
const condicionBusqueda = (
  buscar: string,
  param: (valor: unknown) => string,
  porTelefono: { minimoDigitos: number; soloSi?: string | null } | null,
) => {
  const nombre = `c.nombre ILIKE ${param(`%${textoLiteral(buscar)}%`)} ESCAPE '\\'`;
  const digitos = porTelefono && /^[\d\s+().-]+$/.test(buscar) ? buscar.replace(/\D/g, '') : '';
  if (!porTelefono || digitos.length < Math.max(1, porTelefono.minimoDigitos)) return nombre;
  const telefono = `regexp_replace(c.telefono, '[^0-9]', '', 'g') LIKE ${param(`%${digitos}%`)}`;
  return `(${nombre} OR ${porTelefono.soloSi ? `(${porTelefono.soloSi} AND ${telefono})` : telefono})`;
};

// El cliente tiene o tuvo al menos una cita (de cualquier estado) con ese profesional
const citaConElProfesional = (profesional: string) =>
  `EXISTS (SELECT 1 FROM citas ci WHERE ci.empresa_id = c.empresa_id AND ci.cliente_id = c.id AND ci.barbero_id = ${profesional}::varchar)`;

// Una página de clientes (keyset): los que van después de "despues" en el orden de la lista. "buscar" filtra por
// nombre o, si es un número, por los dígitos del teléfono. Trae limite + 1 filas para saber si hay más.
export const listarClientesPagina = async (
  db: Consultable,
  empresaId: string,
  p: { limite: number; despues: PosicionCliente | null; buscar: string | null },
) => {
  const parametros: unknown[] = [empresaId];
  const condiciones = ['c.empresa_id = $1'];
  const param = (valor: unknown) => `$${parametros.push(valor)}`;

  if (p.buscar) condiciones.push(condicionBusqueda(p.buscar, param, { minimoDigitos: 1 }));
  if (p.despues) {
    const mismoOrden = `(c.nombre, c.id) > (${param(p.despues.nombre)}::varchar, ${param(p.despues.id)}::varchar)`;
    if (p.despues.fecha === null) {
      condiciones.push(`(c.fecha_ultima_cita IS NULL AND ${mismoOrden})`);
    } else {
      const fecha = param(p.despues.fecha);
      condiciones.push(
        `(c.fecha_ultima_cita < ${fecha}::date OR c.fecha_ultima_cita IS NULL
          OR (c.fecha_ultima_cita = ${fecha}::date AND ${mismoOrden}))`,
      );
    }
  }
  const limite = param(p.limite + 1);
  return (
    await db.query<FilaCliente>(
      `SELECT ${COLUMNAS_CLIENTE} ${DESDE_CLIENTES}
       WHERE ${condiciones.join(' AND ')}
       ORDER BY c.fecha_ultima_cita DESC NULLS LAST, c.nombre, c.id
       LIMIT ${limite}`,
      parametros,
    )
  ).rows;
};

export type FilaClienteSelector = {
  id: string;
  nombre: string;
  telefono: string;
  indicativo: string;
  // El cliente tiene o tuvo citas con el profesional indicado en "soloDelProfesional" (true si no se indicó ninguno)
  es_propio: boolean;
};

// Selector de "cliente existente" (admin y empleado): solo id, nombre y contacto, sin estadísticas del negocio.
// Siempre del negocio indicado y en el orden de la lista; trae limite + 1 filas para saber si hay más.
// Con soloDelProfesional (un empleado), es_propio marca a sus clientes y la búsqueda por teléfono solo alcanza a ellos.
export const buscarClientesSelector = async (
  db: Consultable,
  empresaId: string,
  p: {
    buscar: string;
    porTelefono: { minimoDigitos: number } | null;
    soloDelProfesional: string | null;
    limite: number;
  },
) => {
  const parametros: unknown[] = [empresaId];
  const param = (valor: unknown) => `$${parametros.push(valor)}`;
  const propio = p.soloDelProfesional ? citaConElProfesional(param(p.soloDelProfesional)) : null;
  const condicion = condicionBusqueda(p.buscar, param, p.porTelefono && { ...p.porTelefono, soloSi: propio });
  const limite = param(p.limite + 1);
  return (
    await db.query<FilaClienteSelector>(
      `SELECT c.id, c.nombre, c.telefono, c.indicativo, ${propio ?? 'true'} AS es_propio FROM clientes c
       WHERE c.empresa_id = $1 AND ${condicion}
       ORDER BY c.fecha_ultima_cita DESC NULLS LAST, c.nombre, c.id
       LIMIT ${limite}`,
      parametros,
    )
  ).rows;
};

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
