import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CODIGO_PG, enTransaccion, esErrorPg } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import type { Sesion } from '../auth/auth.servicio.js';
import { cifrarContrasena } from '../auth/contrasenas.js';
import {
  contarEquipoCobrable,
  MENSAJE_SOLO_ADMIN_SIN_ATENDER,
  reajustarCobro,
  validarTopes,
} from '../empresas/cobro.js';
import type { ServicioTokens } from '../auth/tokens.js';
import { type AlmacenFotos, urlFoto } from '../empresas/fotos.js';
import * as repositorio from './equipo.repositorio.js';
import type { FilaMiembro } from './equipo.repositorio.js';

const NO_ENCONTRADO = 'Profesional no encontrado';

export type DatosMiembro = {
  nombre: string;
  usuario: string;
  clave: string;
  esAdmin: boolean;
  atiendeClientes: boolean;
  especialidad: string | null | undefined;
  porcentajeGanancia: number;
};

// Misma forma que los barberos de /empresas/actual (sin "clave" ni "equipo")
const armarMiembro = (m: FilaMiembro, urlBase: string) => ({
  id: m.id,
  nombre: m.nombre,
  usuario: m.usuario,
  // true = perfil de la cuenta de la administradora ("Yo también atiendo clientes"): entra con esa cuenta
  cuentaAdministradora: m.usuario_id !== null,
  rol: m.es_admin ? ('admin' as const) : ('empleado' as const),
  esAdmin: m.es_admin,
  atiendeClientes: m.atiende_clientes,
  especialidad: m.especialidad,
  porcentajeGanancia: Number(m.porcentaje_ganancia),
  foto: urlFoto(urlBase, m.foto_url),
});

const PERFIL_DE_CUENTA =
  'Este perfil es el de la cuenta de la administradora: su usuario, contraseña y rol se cambian en su cuenta. ' +
  'Para que deje de recibir reservas, desactiva "Yo también atiendo clientes".';

const cuentaDe = (sesion: Sesion) => {
  if (!sesion.usuarioId) {
    throw errores.prohibido('Esta opción es solo para la cuenta de administración (la de correo). Tu perfil ya está en el equipo.');
  }
  return sesion.usuarioId;
};

const respuestaAtiende = (perfil: FilaMiembro | undefined, urlBase: string) => ({
  atiendeClientes: Boolean(perfil?.atiende_clientes),
  // Id del profesional de la administradora (para filtrar su cartera o su agenda); null si nunca lo activó
  barberoId: perfil?.id ?? null,
  perfil: perfil ? armarMiembro(perfil, urlBase) : null,
});

// El usuario de inicio de sesión es único entre el equipo activo de todos los negocios
const traducirUsuarioRepetido = (error: unknown): never => {
  if (esErrorPg(error, CODIGO_PG.violacionUnica)) throw errores.conflicto('Ese usuario ya está en uso. Elige otro.');
  throw error;
};

export const crearServicioEquipo = ({ pool, fotos, tokens }: { pool: pg.Pool; fotos: AlmacenFotos; tokens: ServicioTokens }) => ({
  async listar(empresaId: string, urlBase: string) {
    return (await repositorio.listarEquipo(pool, empresaId)).map((m) => armarMiembro(m, urlBase));
  },

  // Se cobra por cada profesional que atiende clientes (máximo 10); los administradores que no atienden no
  // se cobran (máximo 2). Si el plan ya está pagado, agregar uno genera un cargo proporcional pendiente.
  async crear(empresaId: string, { clave, ...datos }: DatosMiembro, urlBase: string) {
    if (!datos.esAdmin && !datos.atiendeClientes) throw errores.solicitudInvalida(MENSAJE_SOLO_ADMIN_SIN_ATENDER);
    const passwordHash = await cifrarContrasena(clave);
    const miembro = await enTransaccion(pool, async (tx) => {
      if (!(await repositorio.bloquearLimiteEquipo(tx, empresaId))) throw errores.noEncontrado('Establecimiento no encontrado');
      validarTopes(
        await contarEquipoCobrable(tx, empresaId),
        datos.atiendeClientes ? { cobrados: 1 } : { adminsSinAtender: 1 },
      );
      const creado = await repositorio.crearMiembro(tx, {
        ...datos,
        id: randomUUID(),
        empresaId,
        especialidad: datos.especialidad ?? null,
        passwordHash,
      });
      await reajustarCobro(tx, empresaId, creado.id);
      return creado;
    }).catch(traducirUsuarioRepetido);
    return armarMiembro(miembro, urlBase);
  },

  async actualizar(sesion: Sesion, id: string, { clave, ...cambios }: Partial<DatosMiembro>, urlBase: string) {
    const actual = (await repositorio.listarEquipo(pool, sesion.empresaId)).find((m) => m.id === id);
    if (actual?.usuario_id && (clave !== undefined || cambios.usuario !== undefined || cambios.esAdmin !== undefined)) {
      throw errores.solicitudInvalida(PERFIL_DE_CUENTA);
    }
    // Un barbero administrador no puede quitarse a sí mismo el rol (perdería el acceso)
    if (sesion.barberoId === id && cambios.esAdmin === false) {
      throw errores.solicitudInvalida('No puedes quitarte a ti mismo el rol de administrador.');
    }
    const passwordHash = clave === undefined ? undefined : await cifrarContrasena(clave);
    const miembro = await enTransaccion(pool, async (tx) => {
      await repositorio.bloquearLimiteEquipo(tx, sesion.empresaId);
      // Cambiar quién atiende cambia lo que se cobra: se revisan los topes con el equipo resultante
      if (actual && (cambios.atiendeClientes !== undefined || cambios.esAdmin !== undefined)) {
        const esAdmin = cambios.esAdmin ?? actual.es_admin;
        const atiende = cambios.atiendeClientes ?? actual.atiende_clientes;
        if (!esAdmin && !atiende) throw errores.solicitudInvalida(MENSAJE_SOLO_ADMIN_SIN_ATENDER);
        const sinAtender = (admin: boolean, atiendeAntes: boolean) => (admin && !atiendeAntes ? 1 : 0);
        validarTopes(await contarEquipoCobrable(tx, sesion.empresaId), {
          cobrados: Number(atiende) - Number(actual.atiende_clientes),
          adminsSinAtender: sinAtender(esAdmin, atiende) - sinAtender(actual.es_admin, actual.atiende_clientes),
        });
      }
      const cambiado = await repositorio.actualizarMiembro(tx, id, sesion.empresaId, { ...cambios, passwordHash });
      if (cambiado) await reajustarCobro(tx, sesion.empresaId, cambiado.id);
      return cambiado;
    }).catch(traducirUsuarioRepetido);
    if (!miembro) throw errores.noEncontrado(NO_ENCONTRADO);
    // Una contraseña nueva cierra las sesiones abiertas de ese integrante. Si quien la cambió es él mismo, se le
    // entrega un token nuevo para que su sesión actual siga: las demás quedan cerradas.
    const propiaSesion = clave !== undefined && sesion.barberoId === id;
    return {
      ...armarMiembro(miembro, urlBase),
      ...(propiaSesion && {
        token: tokens.firmar({ barberoId: miembro.id, empresaId: sesion.empresaId, version: miembro.version_sesion }),
      }),
    };
  },

  async borrar(sesion: Sesion, id: string) {
    if (sesion.barberoId === id) throw errores.solicitudInvalida('No puedes eliminar tu propio usuario.');
    if ((await repositorio.listarEquipo(pool, sesion.empresaId)).find((m) => m.id === id)?.usuario_id) {
      throw errores.solicitudInvalida(PERFIL_DE_CUENTA);
    }
    const pendientes = await repositorio.contarCitasPendientes(pool, id, sesion.empresaId);
    if (pendientes > 0) {
      throw errores.conflicto(
        `Este profesional tiene ${pendientes} cita(s) pendiente(s). Cancélalas antes de eliminarlo.`,
      );
    }
    // Quitar no devuelve dinero; la próxima renovación se calcula con los profesionales activos
    const borrado = await enTransaccion(pool, async (tx) => {
      await repositorio.bloquearLimiteEquipo(tx, sesion.empresaId);
      const desactivado = await repositorio.desactivarMiembro(tx, id, sesion.empresaId);
      if (desactivado) await reajustarCobro(tx, sesion.empresaId);
      return desactivado;
    });
    if (!borrado) throw errores.noEncontrado(NO_ENCONTRADO);
    await fotos.borrar(borrado.foto_url);
    return { mensaje: 'Profesional eliminado' };
  },

  // "Yo también atiendo clientes": solo la cuenta de la administradora (la de correo). Activarlo crea o
  // habilita su perfil de profesional vinculado a su cuenta (sin otro usuario) y cuenta como profesional cobrado.
  async estadoAtiende(sesion: Sesion, urlBase: string) {
    const perfil = await repositorio.buscarPerfilDeCuenta(pool, cuentaDe(sesion));
    return respuestaAtiende(perfil?.activo ? perfil : perfil && { ...perfil, atiende_clientes: false }, urlBase);
  },

  async cambiarAtiende(sesion: Sesion, atiende: boolean, urlBase: string) {
    const usuarioId = cuentaDe(sesion);
    const perfil = await enTransaccion(pool, async (tx) => {
      const limite = await repositorio.bloquearLimiteEquipo(tx, sesion.empresaId);
      if (!limite) throw errores.noEncontrado('Establecimiento no encontrado');
      const actual = await repositorio.buscarPerfilDeCuenta(tx, usuarioId, true);
      let resultado: FilaMiembro | undefined;
      if (!atiende) {
        if (!actual?.activo) return actual;
        // Con citas pendientes sigue activo (para ver su agenda), pero ya no recibe reservas nuevas ni se cobra
        const pendientes = await repositorio.contarCitasPendientes(tx, actual.id, sesion.empresaId);
        resultado = await repositorio.cambiarPerfilDeCuenta(tx, sesion.empresaId, actual.id, pendientes > 0, false);
      } else {
        // Atender clientes lo cuenta como profesional cobrado
        if (!(actual?.activo && actual.atiende_clientes)) validarTopes(await contarEquipoCobrable(tx, sesion.empresaId), { cobrados: 1 });
        if (actual) {
          resultado = await repositorio.cambiarPerfilDeCuenta(tx, sesion.empresaId, actual.id, true, true);
        } else {
          const nombre = (await repositorio.nombreDeLaAdministradora(tx, sesion.empresaId)) ?? 'Administradora';
          resultado = await repositorio.crearPerfilDeCuenta(tx, { id: randomUUID(), empresaId: sesion.empresaId, usuarioId, nombre });
        }
      }
      await reajustarCobro(tx, sesion.empresaId, resultado?.id ?? null);
      return resultado;
    });
    return {
      mensaje: atiende ? 'Ahora también atiendes clientes' : 'Dejaste de recibir reservas nuevas. Tus citas se conservan.',
      ...respuestaAtiende(perfil, urlBase),
    };
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
