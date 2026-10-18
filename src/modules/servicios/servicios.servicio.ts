import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import * as repositorio from './servicios.repositorio.js';
import type { FilaServicio } from './servicios.repositorio.js';

const NO_ENCONTRADO = 'Servicio no encontrado';

type DatosServicio = { nombre: string; duracionMin: number; precio: number };

// Misma forma que los servicios de /empresas/actual, más duracionMin numérico
const armarServicio = (s: FilaServicio) => ({
  id: s.id,
  nombre: s.nombre,
  duracionMin: s.duracion_min,
  duracion: `${s.duracion_min} min`,
  precio: Number(s.precio),
});

export const crearServicioServicios = ({ pool }: { pool: pg.Pool }) => ({
  async listar(empresaId: string) {
    return (await repositorio.listarServicios(pool, empresaId)).map(armarServicio);
  },

  async crear(empresaId: string, datos: DatosServicio) {
    return armarServicio(await repositorio.crearServicio(pool, { id: randomUUID(), empresaId, ...datos }));
  },

  async actualizar(empresaId: string, id: string, cambios: Partial<DatosServicio>) {
    const servicio = await repositorio.actualizarServicio(pool, { id, empresaId, ...cambios });
    if (!servicio) throw errores.noEncontrado(NO_ENCONTRADO);
    return armarServicio(servicio);
  },

  async borrar(empresaId: string, id: string) {
    if (!(await repositorio.desactivarServicio(pool, id, empresaId))) throw errores.noEncontrado(NO_ENCONTRADO);
    return { mensaje: 'Servicio eliminado' };
  },
});

export type ServicioServicios = ReturnType<typeof crearServicioServicios>;
