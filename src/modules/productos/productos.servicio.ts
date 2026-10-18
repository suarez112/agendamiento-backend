import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import { type AlmacenFotos, urlFoto } from '../empresas/fotos.js';
import * as repositorio from './productos.repositorio.js';
import type { FilaProducto } from './productos.repositorio.js';

const NO_ENCONTRADO = 'Producto no encontrado';
const CODIGO_VALIDO = /^[A-Z0-9_-]{1,32}$/;

type DatosProducto = { nombre: string; precio: number; descripcion?: string | null };

const armarProducto = (p: FilaProducto, urlBase: string) => ({
  id: p.id,
  nombre: p.nombre,
  descripcion: p.descripcion,
  precio: Number(p.precio),
  fotoUrl: urlFoto(urlBase, p.foto_url),
});

export const crearServicioProductos = ({ pool, fotos }: { pool: pg.Pool; fotos: AlmacenFotos }) => ({
  async listar(empresaId: string, urlBase: string) {
    return (await repositorio.listarProductos(pool, empresaId)).map((p) => armarProducto(p, urlBase));
  },

  // Catálogo público por el código de acceso del negocio
  async catalogo(codigo: string, urlBase: string) {
    const limpio = codigo.trim().toUpperCase();
    const productos = CODIGO_VALIDO.test(limpio)
      ? await repositorio.listarCatalogoPorCodigo(pool, limpio)
      : undefined;
    if (!productos) throw errores.noEncontrado('Establecimiento no encontrado');
    return productos.map((p) => armarProducto(p, urlBase));
  },

  async crear(empresaId: string, datos: DatosProducto, urlBase: string) {
    return armarProducto(await repositorio.crearProducto(pool, { empresaId, ...datos }), urlBase);
  },

  async actualizar(empresaId: string, id: string, cambios: Partial<DatosProducto>, urlBase: string) {
    const producto = await repositorio.actualizarProducto(pool, { id, empresaId, ...cambios });
    if (!producto) throw errores.noEncontrado(NO_ENCONTRADO);
    return armarProducto(producto, urlBase);
  },

  async borrar(empresaId: string, id: string) {
    const borrado = await repositorio.borrarProducto(pool, id, empresaId);
    if (!borrado) throw errores.noEncontrado(NO_ENCONTRADO);
    await fotos.borrar(borrado.foto_url);
    return { mensaje: 'Producto eliminado' };
  },

  // Igual que la foto del negocio: primero guarda el archivo nuevo; si la base
  // no se actualiza, lo borra. La foto anterior se borra solo al final.
  async cambiarFoto(empresaId: string, id: string, datos: Buffer, urlBase: string) {
    const ruta = await fotos.guardar(datos);
    let cambio: Awaited<ReturnType<typeof repositorio.cambiarFotoProducto>>;
    try {
      cambio = await repositorio.cambiarFotoProducto(pool, id, empresaId, ruta);
    } catch (error) {
      await fotos.borrar(ruta);
      throw error;
    }
    if (!cambio) {
      await fotos.borrar(ruta);
      throw errores.noEncontrado(NO_ENCONTRADO);
    }
    await fotos.borrar(cambio.foto_anterior);
    return { mensaje: 'Foto del producto actualizada', fotoUrl: urlFoto(urlBase, ruta) };
  },

  async quitarFoto(empresaId: string, id: string) {
    const cambio = await repositorio.cambiarFotoProducto(pool, id, empresaId, null);
    if (!cambio) throw errores.noEncontrado(NO_ENCONTRADO);
    await fotos.borrar(cambio.foto_anterior);
    return { mensaje: 'Foto del producto eliminada', fotoUrl: null };
  },
});

export type ServicioProductos = ReturnType<typeof crearServicioProductos>;
