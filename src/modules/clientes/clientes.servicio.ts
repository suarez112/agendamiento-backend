import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import { aIsoEnZona } from '../../shared/zonaHoraria.js';
import type { Sesion } from '../auth/auth.servicio.js';
import { buscarZonaHoraria } from '../empresas/empresas.repositorio.js';
import * as repositorio from './clientes.repositorio.js';
import type { FilaCliente, FilaListaNegra } from './clientes.repositorio.js';
import { puedeVerTelefonos, telefonoVisible } from './privacidad.js';

const CLIENTE_NO_ENCONTRADO = 'Cliente no encontrado';

const armarCliente = (c: FilaCliente) => ({
  id: c.id,
  nombre: c.nombre,
  telefono: c.telefono,
  indicativo: c.indicativo,
  totalCitas: c.total_citas,
  citasCompletadas: c.citas_completadas,
  citasCanceladas: c.citas_canceladas,
  fechaUltimaCita: c.fecha_ultima_cita,
  // Activo: cita (no cancelada) en los últimos 45 días, hoy o próxima
  estado: c.activo ? ('activo' as const) : ('inactivo' as const),
  enListaNegra: c.lista_negra_id !== null,
  listaNegraId: c.lista_negra_id,
});

const armarEntrada = (e: FilaListaNegra, zona: string) => ({
  id: e.id,
  nombre: e.nombre,
  telefono: e.telefono,
  agregadoEn: aIsoEnZona(e.agregado_en, zona),
  zonaHoraria: zona,
});

// Selector de "cliente existente": máximo de resultados por búsqueda y mínimo de dígitos para buscar por teléfono,
// para que no se pueda recorrer toda la lista de clientes del negocio
export const MAXIMO_SELECTOR = 10;
const MINIMO_DIGITOS_SELECTOR = 3;

export const CURSOR_INVALIDO = 'El cursor no es válido. Vuelve a pedir la primera página.';

// El cursor es opaco para la app y solo lleva el id del último cliente de la página (base64url): mide siempre lo
// mismo, sin importar lo largo del nombre. Su posición (fecha y nombre) se lee de la base, siempre dentro del
// negocio de la sesión; un id de otro negocio o que ya no existe es un cursor inválido.
const codificarCursor = (c: FilaCliente) => Buffer.from(c.id).toString('base64url');

const leerCursor = (cursor: string) => {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw errores.solicitudInvalida(CURSOR_INVALIDO);
  return id;
};

const posicionDelCursor = async (pool: pg.Pool, empresaId: string, cursor?: string) => {
  if (cursor === undefined) return null;
  const posicion = await repositorio.buscarPosicionCliente(pool, empresaId, leerCursor(cursor));
  if (!posicion) throw errores.solicitudInvalida(CURSOR_INVALIDO);
  return posicion;
};

export const crearServicioClientes = ({ pool }: { pool: pg.Pool }) => ({
  async listar(empresaId: string) {
    return (await repositorio.listarClientes(pool, empresaId)).map(armarCliente);
  },

  // Una página de clientes, en el mismo orden que la lista completa. siguienteCursor = null en la última.
  async listarPagina(empresaId: string, p: { limite: number; cursor?: string; q?: string }) {
    const filas = await repositorio.listarClientesPagina(pool, empresaId, {
      limite: p.limite,
      despues: await posicionDelCursor(pool, empresaId, p.cursor),
      buscar: p.q?.trim() || null,
    });
    const pagina = filas.slice(0, p.limite);
    return {
      datos: pagina.map(armarCliente),
      siguienteCursor: filas.length > p.limite ? codificarCursor(pagina[pagina.length - 1]!) : null,
    };
  },

  // Selector de "cliente existente" (administradores y empleados del negocio de la sesión). El nombre se ve siempre.
  // Teléfono e indicativo (y la búsqueda por teléfono):
  // - administrador: de todos los clientes del negocio;
  // - empleado con la opción del negocio apagada: de ninguno (null y busca solo por nombre);
  // - empleado con la opción encendida: solo de los clientes que tienen o tuvieron citas con él; los demás salen en
  //   null y buscar por su teléfono no los encuentra (si no, la búsqueda confirmaría de quién es cada número).
  async buscarParaSelector(sesion: Sesion, q: string) {
    // Niega por defecto: un empleado sin profesional asociado no debería existir (el tipo Sesion lo impide), pero si
    // llegara uno no se le muestra ni se le deja buscar ningún teléfono, en vez de tratarlo como administrador
    const sinProfesional = !sesion.esAdmin && !sesion.barberoId;
    const verTelefonos = !sinProfesional && (await puedeVerTelefonos(pool, sesion));
    const filas = await repositorio.buscarClientesSelector(pool, sesion.empresaId, {
      buscar: q,
      porTelefono: verTelefonos ? { minimoDigitos: MINIMO_DIGITOS_SELECTOR } : null,
      soloDelProfesional: verTelefonos && !sesion.esAdmin ? sesion.barberoId : null,
      limite: MAXIMO_SELECTOR,
    });
    return {
      datos: filas.slice(0, MAXIMO_SELECTOR).map((c) => {
        const ver = verTelefonos && c.es_propio;
        return {
          id: c.id,
          nombre: c.nombre,
          telefono: telefonoVisible(c.telefono, ver),
          indicativo: telefonoVisible(c.indicativo, ver),
        };
      }),
      hayMas: filas.length > MAXIMO_SELECTOR,
      telefonosVisibles: verTelefonos,
    };
  },

  // Datos del cliente y todas sus citas en el negocio
  async historial(empresaId: string, clienteId: string) {
    const cliente = await repositorio.buscarCliente(pool, clienteId, empresaId);
    if (!cliente) throw errores.noEncontrado(CLIENTE_NO_ENCONTRADO);
    const citas = await repositorio.listarCitasCliente(pool, clienteId, empresaId);
    return {
      cliente: armarCliente(cliente),
      citas: citas.map((c) => ({
        id: c.id,
        fecha: c.fecha,
        hora: c.hora,
        servicio: c.servicio,
        barberoId: c.barbero_id,
        barberoNombre: c.barbero_nombre,
        precio: Number(c.precio),
        estado: c.estado,
      })),
    };
  },

  async listaNegra(empresaId: string) {
    const zona = (await buscarZonaHoraria(pool, empresaId))!;
    return (await repositorio.listarListaNegra(pool, empresaId)).map((e) => armarEntrada(e, zona));
  },

  async agregarAListaNegra(empresaId: string, clienteId: string) {
    const cliente = await repositorio.buscarCliente(pool, clienteId, empresaId);
    if (!cliente) throw errores.noEncontrado(CLIENTE_NO_ENCONTRADO);
    const entrada = await repositorio.agregarAListaNegra(pool, {
      empresaId,
      nombre: cliente.nombre,
      telefono: cliente.telefono,
    });
    if (!entrada) throw errores.conflicto('Este cliente ya está en la lista negra');
    return {
      mensaje: 'Cliente agregado a la lista negra',
      ...armarEntrada(entrada, (await buscarZonaHoraria(pool, empresaId))!),
    };
  },

  async quitarDeListaNegra(empresaId: string, id: string) {
    if (!(await repositorio.quitarDeListaNegra(pool, id, empresaId))) {
      throw errores.noEncontrado('Ese registro no está en la lista negra');
    }
    return { mensaje: 'Cliente quitado de la lista negra' };
  },
});

export type ServicioClientes = ReturnType<typeof crearServicioClientes>;
