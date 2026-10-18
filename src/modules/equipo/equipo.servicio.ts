import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CODIGO_PG, esErrorPg } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import type { Sesion } from '../auth/auth.servicio.js';
import { cifrarContrasena } from '../auth/contrasenas.js';
import { type AlmacenFotos, urlFoto } from '../empresas/fotos.js';
import * as repositorio from './equipo.repositorio.js';
import type { FilaMiembro } from './equipo.repositorio.js';

const NO_ENCONTRADO = 'Profesional no encontrado';

export type DatosMiembro = {
  nombre: string;
  usuario: string;
  clave: string;
  esAdmin: boolean;
  especialidad: string | null | undefined;
  porcentajeGanancia: number;
};

// Misma forma que los barberos de /empresas/actual (sin "clave" ni "equipo")
const armarMiembro = (m: FilaMiembro, urlBase: string) => ({
  id: m.id,
  nombre: m.nombre,
  usuario: m.usuario,
  esAdmin: m.es_admin,
  especialidad: m.especialidad,
  porcentajeGanancia: Number(m.porcentaje_ganancia),
  foto: urlFoto(urlBase, m.foto_url),
});

// El usuario de inicio de sesión es único entre el equipo activo de todos los negocios
const traducirUsuarioRepetido = (error: unknown): never => {
  if (esErrorPg(error, CODIGO_PG.violacionUnica)) throw errores.conflicto('Ese usuario ya está en uso. Elige otro.');
  throw error;
};

export const crearServicioEquipo = ({ pool, fotos }: { pool: pg.Pool; fotos: AlmacenFotos }) => ({
  async listar(empresaId: string, urlBase: string) {
    return (await repositorio.listarEquipo(pool, empresaId)).map((m) => armarMiembro(m, urlBase));
  },

  async crear(empresaId: string, { clave, ...datos }: DatosMiembro, urlBase: string) {
    const miembro = await repositorio
      .crearMiembro(pool, {
        ...datos,
        id: randomUUID(),
        empresaId,
        especialidad: datos.especialidad ?? null,
        passwordHash: await cifrarContrasena(clave),
      })
      .catch(traducirUsuarioRepetido);
    return armarMiembro(miembro, urlBase);
  },

  async actualizar(sesion: Sesion, id: string, { clave, ...cambios }: Partial<DatosMiembro>, urlBase: string) {
    // Un barbero administrador no puede quitarse a sí mismo el rol (perdería el acceso)
    if (sesion.barberoId === id && cambios.esAdmin === false) {
      throw errores.solicitudInvalida('No puedes quitarte a ti mismo el rol de administrador.');
    }
    const passwordHash = clave === undefined ? undefined : await cifrarContrasena(clave);
    const miembro = await repositorio
      .actualizarMiembro(pool, id, sesion.empresaId, { ...cambios, passwordHash })
      .catch(traducirUsuarioRepetido);
    if (!miembro) throw errores.noEncontrado(NO_ENCONTRADO);
    return armarMiembro(miembro, urlBase);
  },

  async borrar(sesion: Sesion, id: string) {
    if (sesion.barberoId === id) throw errores.solicitudInvalida('No puedes eliminar tu propio usuario.');
    const pendientes = await repositorio.contarCitasPendientes(pool, id, sesion.empresaId);
    if (pendientes > 0) {
      throw errores.conflicto(
        `Este profesional tiene ${pendientes} cita(s) pendiente(s). Cancélalas antes de eliminarlo.`,
      );
    }
    const borrado = await repositorio.desactivarMiembro(pool, id, sesion.empresaId);
    if (!borrado) throw errores.noEncontrado(NO_ENCONTRADO);
    await fotos.borrar(borrado.foto_url);
    return { mensaje: 'Profesional eliminado' };
  },

  // Igual que la foto del negocio: primero guarda el archivo nuevo; si la base
  // no se actualiza, lo borra. La foto anterior se borra solo al final.
  async cambiarFoto(empresaId: string, id: string, datos: Buffer, urlBase: string) {
    const ruta = await fotos.guardar(datos);
    let cambio: Awaited<ReturnType<typeof repositorio.cambiarFotoMiembro>>;
    try {
      cambio = await repositorio.cambiarFotoMiembro(pool, id, empresaId, ruta);
    } catch (error) {
      await fotos.borrar(ruta);
      throw error;
    }
    if (!cambio) {
      await fotos.borrar(ruta);
      throw errores.noEncontrado(NO_ENCONTRADO);
    }
    await fotos.borrar(cambio.foto_anterior);
    return { mensaje: 'Foto del profesional actualizada', foto: urlFoto(urlBase, ruta) };
  },
});

export type ServicioEquipo = ReturnType<typeof crearServicioEquipo>;
