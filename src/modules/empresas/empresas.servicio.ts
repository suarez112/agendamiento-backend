import type pg from 'pg';
import { CODIGO_PG, enTransaccion, esErrorPg } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import type { CambiosEmpresa } from './empresas.esquemas.js';
import * as repositorio from './empresas.repositorio.js';
import { armarHorario, guardarHorario, listarHorarios } from './horario.js';
import { type AlmacenFotos, urlFoto } from './fotos.js';
import type { FilaEmpresa, FilaPerfilEmpresa } from './empresas.repositorio.js';

// Mismo formato que la restricción empresas_codigo_acceso_valido (migración 007)
const CODIGO_VALIDO = /^[A-Z0-9]{1,10}$/;

export const CODIGO_REPETIDO = 'Ese código ya lo usa otro negocio. Elige otro.';

type Visibilidad = {
  // Los usuarios de inicio de sesión solo se muestran al personal del negocio.
  // El código del negocio es público (lo usan los clientes para reservar).
  incluirUsuarios: boolean;
};

export const crearServicioEmpresas = ({ pool, fotos }: { pool: pg.Pool; fotos: AlmacenFotos }) => {
  const armarNegocio = async (empresa: FilaEmpresa, { incluirUsuarios }: Visibilidad, urlBase: string) => {
    const [barberos, servicios, horario] = await Promise.all([
      repositorio.listarBarberos(pool, empresa.id),
      repositorio.listarServicios(pool, empresa.id),
      listarHorarios(pool, [empresa.id]),
    ]);
    const { horario: dias, horarioApertura, horarioCierre } = armarHorario(horario);

    return {
      empresa: {
        id: empresa.id,
        nombre: empresa.nombre,
        codigoAcceso: empresa.codigo_acceso,
        colorPrimario: empresa.color_primario,
        colorSecundario: empresa.color_secundario,
        // Apertura más temprana y cierre más tardío de la semana (la app de antes los usa);
        // el horario de cada día está en "horario"
        horarioApertura,
        horarioCierre,
        horario: dias,
      },
      barberos: barberos.map((b) => ({
        id: b.id,
        nombre: b.nombre,
        usuario: incluirUsuarios ? b.usuario : '',
        clave: '', // por seguridad, el servidor nunca envía contraseñas
        esAdmin: b.es_admin,
        especialidad: b.especialidad ?? '',
        equipo: `${empresa.nombre} TEAM`,
        porcentajeGanancia: Number(b.porcentaje_ganancia),
        foto: urlFoto(urlBase, b.foto_url) ?? undefined,
      })),
      servicios: servicios.map((s) => ({
        id: s.id,
        nombre: s.nombre,
        duracion: `${s.duracion_min} min`,
        precio: Number(s.precio),
      })),
    };
  };

  const conHorario = async (perfil: FilaPerfilEmpresa) => ({
    perfil,
    horario: armarHorario(await listarHorarios(pool, [perfil.id])),
  });

  return {
    // Vista pública para clientes que reservan con el código del negocio
    async negocioPorCodigo(codigo: string, urlBase: string) {
      const limpio = codigo.trim().toUpperCase();
      const empresa = CODIGO_VALIDO.test(limpio)
        ? await repositorio.buscarEmpresaPorCodigo(pool, limpio)
        : undefined;
      if (!empresa) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarNegocio(empresa, { incluirUsuarios: false }, urlBase);
    },

    // Vista para el personal con sesión iniciada: su propio negocio
    async negocioDeSesion(empresaId: string, urlBase: string) {
      const empresa = await repositorio.buscarEmpresaPorId(pool, empresaId);
      if (!empresa) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarNegocio(empresa, { incluirUsuarios: true }, urlBase);
    },

    // Información del negocio para clientes: sin NIT, datos internos ni suscripción.
    // urlBase arma la dirección completa de la foto (ej. https://api.mibarberia.co).
    async perfilPublico(codigo: string, urlBase: string) {
      const limpio = codigo.trim().toUpperCase();
      const perfil = CODIGO_VALIDO.test(limpio)
        ? await repositorio.buscarPerfilEmpresaPorCodigo(pool, limpio)
        : undefined;
      if (!perfil) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarPerfilPublico(await conHorario(perfil), urlBase);
    },

    // Perfil de la empresa del administrador. El id sale siempre de la sesión.
    async perfilDeAdmin(empresaId: string, urlBase: string) {
      const perfil = await repositorio.buscarPerfilEmpresa(pool, empresaId);
      if (!perfil) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarPerfil(await conHorario(perfil), urlBase);
    },

    // Datos y horario se guardan juntos: si algo falla, no cambia nada
    async actualizarPerfil(empresaId: string, { horario, ...cambios }: CambiosEmpresa, urlBase: string) {
      const perfil = await enTransaccion(pool, async (tx) => {
        const actualizado = await repositorio.actualizarPerfilEmpresa(tx, empresaId, cambios);
        if (actualizado && horario) await guardarHorario(tx, empresaId, horario);
        return actualizado;
      }).catch(traducirErrorPerfil);
      if (!perfil) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarPerfil(await conHorario(perfil), urlBase);
    },

    // Para el registro y "Mi negocio": el código ya viene validado y en mayúsculas
    async codigoDisponible(codigo: string) {
      return { codigo, disponible: await repositorio.codigoDisponible(pool, codigo) };
    },

    // Sube o reemplaza la foto del negocio. Primero guarda el archivo nuevo; si la
    // base no se actualiza, lo borra. La foto anterior se borra solo al final.
    async cambiarFoto(empresaId: string, datos: Buffer, urlBase: string) {
      const ruta = await fotos.guardar(datos);
      let cambio: Awaited<ReturnType<typeof repositorio.cambiarFotoEmpresa>>;
      try {
        cambio = await repositorio.cambiarFotoEmpresa(pool, empresaId, ruta);
      } catch (error) {
        await fotos.borrar(ruta);
        throw error;
      }
      if (!cambio) {
        await fotos.borrar(ruta);
        throw errores.noEncontrado('Establecimiento no encontrado');
      }
      await fotos.borrar(cambio.foto_anterior);
      return { mensaje: 'Foto del negocio actualizada', fotoUrl: urlFoto(urlBase, ruta) };
    },

    // Días de prueba gratuita que le quedan a la empresa (null si no está en prueba)
    async estadoPrueba(empresaId: string) {
      const suscripcion = await repositorio.buscarSuscripcion(pool, empresaId);
      if (!suscripcion) throw errores.noEncontrado('Establecimiento no encontrado');
      return {
        estadoSuscripcion: suscripcion.estado_suscripcion,
        trialEndsAt: suscripcion.trial_ends_at,
        diasRestantes: suscripcion.dias_restantes,
        pruebaVencida: suscripcion.estado_suscripcion === 'trial' && !suscripcion.habilitada,
      };
    },
  };
};

type PerfilConHorario = { perfil: FilaPerfilEmpresa; horario: ReturnType<typeof armarHorario> };

const armarPerfilPublico = ({ perfil: p, horario: h }: PerfilConHorario, urlBase: string) => ({
  id: p.id,
  nombre: p.nombre,
  codigoAcceso: p.codigo_acceso,
  categoria: p.categoria,
  direccion: p.direccion,
  departamento: p.departamento,
  ciudad: p.ciudad,
  horario: h.horario,
  diasAtencion: h.diasAtencion,
  horarioApertura: h.horarioApertura,
  horarioCierre: h.horarioCierre,
  logoUrl: p.logo_url,
  fotoUrl: urlFoto(urlBase, p.foto_url),
  colorPrimario: p.color_primario,
  colorSecundario: p.color_secundario,
});

const armarPerfil = ({ perfil: p, horario: h }: PerfilConHorario, urlBase: string) => ({
  id: p.id,
  nombre: p.nombre,
  codigoAcceso: p.codigo_acceso,
  categoria: p.categoria,
  direccion: p.direccion,
  departamento: p.departamento,
  ciudad: p.ciudad,
  horario: h.horario,
  diasAtencion: h.diasAtencion,
  horarioApertura: h.horarioApertura,
  horarioCierre: h.horarioCierre,
  nombreAdministradora: p.nombre_administradora,
  numeroEmpleados: p.numero_empleados,
  logoUrl: p.logo_url,
  fotoUrl: urlFoto(urlBase, p.foto_url),
  colorPrimario: p.color_primario,
  colorSecundario: p.color_secundario,
  estadoSuscripcion: p.estado_suscripcion,
  trialEndsAt: p.trial_ends_at,
  creadaEn: p.created_at,
});

// Lo que la validación no puede saber sin mirar la base: el código de otro negocio
export const traducirErrorPerfil = (error: unknown): never => {
  const restriccion = (error as { constraint?: string }).constraint;
  if (esErrorPg(error, CODIGO_PG.violacionUnica) && restriccion === 'empresas_codigo_acceso_key') {
    throw errores.conflicto(CODIGO_REPETIDO);
  }
  throw error;
};

export type ServicioEmpresas = ReturnType<typeof crearServicioEmpresas>;
