import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { buscarPlan, type Plan, planSiguiente, PLANES } from '../../config/planes.js';
import { CODIGO_PG, enTransaccion, esErrorPg } from '../../db/pool.js';
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

// Mensaje cuando el equipo ya llenó el cupo de su plan: invita a subir de plan
export const cupoAlcanzado = (plan: Plan, activos: number) => {
  const siguiente = planSiguiente(plan.id);
  const lleno = `Tu equipo ya tiene ${activos} integrante(s) activo(s) y tu plan ${plan.nombre} permite hasta ${plan.cupo}.`;
  return siguiente
    ? `${lleno} Para agregar a alguien más, sube al plan ${siguiente.nombre} (hasta ${siguiente.cupo} personas).`
    : `${lleno} Es el plan más grande: para agregar a alguien, elimina primero del equipo a quien ya no trabaje en el negocio.`;
};

const PERFIL_DE_CUENTA =
  'Este perfil es el de la cuenta de la administradora: su usuario, contraseña y rol se cambian en su cuenta. ' +
  'Para que deje de recibir reservas, desactiva "Yo también atiendo clientes".';

const cuentaDe = (sesion: Sesion) => {
  if (!sesion.usuarioId) {
    throw errores.prohibido('Esta opción es solo para la cuenta de administración (la de correo). Tu perfil ya está en el equipo.');
  }
  return sesion.usuarioId;
};

const sinCupoParaAtender = (plan: Plan, activos: number) => {
  const siguiente = planSiguiente(plan.id);
  const lleno = `No hay cupo para que tú también atiendas: tu equipo ya tiene ${activos} integrante(s) activo(s) y tu plan ${plan.nombre} permite hasta ${plan.cupo}.`;
  return siguiente
    ? `${lleno} Sube al plan ${siguiente.nombre} (hasta ${siguiente.cupo} personas) o elimina a alguien del equipo.`
    : `${lleno} Elimina primero del equipo a quien ya no trabaje en el negocio.`;
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

export const crearServicioEquipo = ({ pool, fotos }: { pool: pg.Pool; fotos: AlmacenFotos }) => ({
  async listar(empresaId: string, urlBase: string) {
    return (await repositorio.listarEquipo(pool, empresaId)).map((m) => armarMiembro(m, urlBase));
  },

  // No puede haber más integrantes activos que el cupo del plan de la empresa
  async crear(empresaId: string, { clave, ...datos }: DatosMiembro, urlBase: string) {
    const passwordHash = await cifrarContrasena(clave);
    const miembro = await enTransaccion(pool, async (tx) => {
      const limite = await repositorio.bloquearLimiteEquipo(tx, empresaId);
      if (!limite) throw errores.noEncontrado('Establecimiento no encontrado');
      const plan = buscarPlan(limite.plan) ?? PLANES[PLANES.length - 1];
      if (limite.activos >= plan.cupo) throw errores.conflicto(cupoAlcanzado(plan, limite.activos));
      return repositorio.crearMiembro(tx, {
        ...datos,
        id: randomUUID(),
        empresaId,
        especialidad: datos.especialidad ?? null,
        passwordHash,
      });
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
    const miembro = await repositorio
      .actualizarMiembro(pool, id, sesion.empresaId, { ...cambios, passwordHash })
      .catch(traducirUsuarioRepetido);
    if (!miembro) throw errores.noEncontrado(NO_ENCONTRADO);
    return armarMiembro(miembro, urlBase);
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
    const borrado = await repositorio.desactivarMiembro(pool, id, sesion.empresaId);
    if (!borrado) throw errores.noEncontrado(NO_ENCONTRADO);
    await fotos.borrar(borrado.foto_url);
    return { mensaje: 'Profesional eliminado' };
  },

  // "Yo también atiendo clientes": solo la cuenta de la administradora (la de correo). Activarlo crea o
  // habilita su perfil de profesional vinculado a su cuenta (sin otro usuario) y ocupa un cupo del plan.
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
      if (!atiende) {
        if (!actual?.activo) return actual;
        // Con citas pendientes conserva el cupo hasta que pasen; en todo caso deja de recibir reservas nuevas
        const pendientes = await repositorio.contarCitasPendientes(tx, actual.id, sesion.empresaId);
        return repositorio.cambiarPerfilDeCuenta(tx, actual.id, pendientes > 0, false);
      }
      if (actual?.activo) return repositorio.cambiarPerfilDeCuenta(tx, actual.id, true, true);
      const plan = buscarPlan(limite.plan) ?? PLANES[PLANES.length - 1];
      if (limite.activos >= plan.cupo) throw errores.conflicto(sinCupoParaAtender(plan, limite.activos));
      if (actual) return repositorio.cambiarPerfilDeCuenta(tx, actual.id, true, true);
      const nombre = (await repositorio.nombreDeLaAdministradora(tx, sesion.empresaId)) ?? 'Administradora';
      return repositorio.crearPerfilDeCuenta(tx, { id: randomUUID(), empresaId: sesion.empresaId, usuarioId, nombre });
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
