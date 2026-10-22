import type pg from 'pg';
import { CODIGO_PG, enTransaccion, esErrorPg } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import * as repositorio from '../superadmin/superadmin.repositorio.js';
import type { SesionSuperadmin } from '../superadmin/superadmin.servicio.js';
import * as categorias from './categorias.repositorio.js';
import type { FilaCategoria } from './categorias.repositorio.js';

const NOMBRE_REPETIDO = 'Ya existe una categoría con ese nombre';
const NO_ENCONTRADA = 'Categoría no encontrada';

const armar = (c: FilaCategoria) => ({ id: c.id, nombre: c.nombre, activa: c.activa });

// Las categorías de negocio. Cualquiera puede ver las activas; solo el superadmin las
// administra, y cada cambio queda en su registro de actividad.
export const crearServicioCategorias = ({ pool }: { pool: pg.Pool }) => {
  const registrar = (db: pg.PoolClient, admin: SesionSuperadmin, accion: string, c: FilaCategoria, detalle: Record<string, unknown>) =>
    repositorio.registrarActividad(db, {
      superadminId: admin.id,
      superadminCorreo: admin.correo,
      accion,
      referencia: c.nombre,
      detalle,
    });

  return {
    // Público: solo las activas
    async listarActivas() {
      return (await categorias.listarCategorias(pool, true)).map(({ id, nombre }) => ({ id, nombre }));
    },

    // Superadmin: todas, con su estado
    async listarTodas() {
      return (await categorias.listarCategorias(pool, false)).map(armar);
    },

    // Nombre oficial de una categoría activa, o 400 si no existe o está desactivada
    async validarActiva(nombre: string) {
      const categoria = await categorias.buscarActivaPorNombre(pool, nombre);
      if (!categoria) throw errores.solicitudInvalida('La categoría no es válida. Elige una de la lista.');
      return categoria.nombre;
    },

    async crear(admin: SesionSuperadmin, nombre: string) {
      return enTransaccion(pool, async (tx) => {
        const creada = await categorias.crearCategoria(tx, nombre);
        if (!creada) throw errores.conflicto(NOMBRE_REPETIDO);
        await registrar(tx, admin, 'crear_categoria', creada, { nombre: creada.nombre });
        return { mensaje: 'Categoría creada', categoria: armar(creada) };
      });
    },

    // Cambia el nombre y/o la desactiva o reactiva. Los negocios que ya la tienen no cambian.
    async actualizar(admin: SesionSuperadmin, id: string, cambios: { nombre?: string; activa?: boolean }) {
      try {
        return await enTransaccion(pool, async (tx) => {
          const antes = await categorias.buscarCategoria(tx, id);
          if (!antes) throw errores.noEncontrado(NO_ENCONTRADA);
          const despues = (await categorias.actualizarCategoria(tx, id, cambios))!;
          await registrar(tx, admin, 'editar_categoria', despues, {
            antes: { nombre: antes.nombre, activa: antes.activa },
            despues: { nombre: despues.nombre, activa: despues.activa },
          });
          return { mensaje: 'Categoría actualizada', categoria: armar(despues) };
        });
      } catch (error) {
        if (esErrorPg(error, CODIGO_PG.violacionUnica)) throw errores.conflicto(NOMBRE_REPETIDO);
        throw error;
      }
    },
  };
};

export type ServicioCategorias = ReturnType<typeof crearServicioCategorias>;
