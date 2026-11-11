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
// porTelefono = null: solo por nombre; si no, cuántos dígitos hacen falta como mínimo para buscar en el teléfono.
// columnaNombre: el nombre sobre el que se busca (por defecto el guardado; para un empleado, el que él ve).
const condicionBusqueda = (
  buscar: string,
  param: (valor: unknown) => string,
  porTelefono: { minimoDigitos: number } | null,
  columnaNombre = 'c.nombre',
) => {
  const nombre = `${columnaNombre} ILIKE ${param(`%${textoLiteral(buscar)}%`)} ESCAPE '\\'`;
  const digitos = porTelefono && /^[\d\s+().-]+$/.test(buscar) ? buscar.replace(/\D/g, '') : '';
  if (!porTelefono || digitos.length < Math.max(1, porTelefono.minimoDigitos)) return nombre;
  const telefono = `regexp_replace(c.telefono, '[^0-9]', '', 'g') LIKE ${param(`%${digitos}%`)}`;
  return `(${nombre} OR ${telefono})`;
};

// El cliente tiene o tuvo al menos una cita (de cualquier estado) con ese profesional
const citaConElProfesional = (profesional: string) =>
  `EXISTS (SELECT 1 FROM citas ci WHERE ci.empresa_id = c.empresa_id AND ci.cliente_id = c.id AND ci.barbero_id = ${profesional}::varchar)`;

// Fecha más lejana de las citas (de cualquier estado) del cliente con ese profesional; puede ser futura. A diferencia
// de clientes.fecha_ultima_cita (que nunca retrocede), usa la fecha actual de cada cita, también si se reprogramó.
const ultimaCitaConElProfesional = (profesional: string) =>
  `(SELECT max(ci.fecha) FROM citas ci WHERE ci.empresa_id = c.empresa_id AND ci.cliente_id = c.id AND ci.barbero_id = ${profesional}::varchar)`;

// Nombre del cliente (alias c) que ve un profesional: el que se escribió en su cita más reciente con él
// (citas.cliente_nombre); si ninguna lo tiene (citas anteriores a la migración 037), el nombre guardado. Así un
// empleado que agendó con el teléfono de un cliente de otro no ve cómo está guardado ese cliente.
export const nombreParaProfesional = (profesional: string) =>
  `COALESCE((SELECT ci.cliente_nombre FROM citas ci
              WHERE ci.empresa_id = c.empresa_id AND ci.cliente_id = c.id AND ci.barbero_id = ${profesional}::varchar
                AND ci.cliente_nombre IS NOT NULL
              ORDER BY ci.created_at DESC, ci.id DESC LIMIT 1), c.nombre)`;

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
};

// Selector de "cliente existente" (admin y empleado): solo id, nombre y contacto, sin estadísticas del negocio.
// Siempre del negocio indicado y en el orden de la lista; trae limite + 1 filas para saber si hay más.
// Con soloDelProfesional (un empleado), solo devuelve (y solo busca entre) los clientes que tienen o tuvieron citas con él,
// con el nombre que él ve (nombreParaProfesional), y busca por ese mismo nombre.
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
  const profesional = p.soloDelProfesional ? param(p.soloDelProfesional) : null;
  const nombre = profesional ? nombreParaProfesional(profesional) : 'c.nombre';
  const condiciones = ['c.empresa_id = $1', condicionBusqueda(p.buscar, param, p.porTelefono, nombre)];
  if (profesional) condiciones.push(citaConElProfesional(profesional));
  // Orden: el administrador, por la última cita del cliente en el negocio; el empleado, por su última cita con él
  // (la del negocio puede ser con otro profesional y revelaría actividad ajena)
  const ultimaCita = profesional ? ultimaCitaConElProfesional(profesional) : 'c.fecha_ultima_cita';
  const limite = param(p.limite + 1);
  return (
    await db.query<FilaClienteSelector>(
      `SELECT c.id, ${nombre} AS nombre, c.telefono, c.indicativo FROM clientes c
       WHERE ${condiciones.join(' AND ')}
       ORDER BY ${ultimaCita} DESC NULLS LAST, ${nombre}, c.id
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
