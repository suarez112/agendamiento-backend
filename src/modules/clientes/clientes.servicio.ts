import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import * as repositorio from './clientes.repositorio.js';
import type { FilaCliente, FilaListaNegra } from './clientes.repositorio.js';

const CLIENTE_NO_ENCONTRADO = 'Cliente no encontrado';

const armarCliente = (c: FilaCliente) => ({
  id: c.id,
  nombre: c.nombre,
  telefono: c.telefono,
  indicativo: c.indicativo,
  totalCitas: c.total_citas,
  fechaUltimaCita: c.fecha_ultima_cita,
  enListaNegra: c.lista_negra_id !== null,
  listaNegraId: c.lista_negra_id,
});

const armarEntrada = (e: FilaListaNegra) => ({
  id: e.id,
  nombre: e.nombre,
  telefono: e.telefono,
  agregadoEn: e.agregado_en,
});

export const crearServicioClientes = ({ pool }: { pool: pg.Pool }) => ({
  async listar(empresaId: string) {
    return (await repositorio.listarClientes(pool, empresaId)).map(armarCliente);
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
    return (await repositorio.listarListaNegra(pool, empresaId)).map(armarEntrada);
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
    return { mensaje: 'Cliente agregado a la lista negra', ...armarEntrada(entrada) };
  },

  async quitarDeListaNegra(empresaId: string, id: string) {
    if (!(await repositorio.quitarDeListaNegra(pool, id, empresaId))) {
      throw errores.noEncontrado('Ese registro no está en la lista negra');
    }
    return { mensaje: 'Cliente quitado de la lista negra' };
  },
});

export type ServicioClientes = ReturnType<typeof crearServicioClientes>;
