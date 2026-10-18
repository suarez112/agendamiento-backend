import type pg from 'pg';
import { CODIGO_PG, esErrorPg } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import { type CambiosEmpresa, MENSAJE_HORARIO } from './empresas.esquemas.js';
import * as repositorio from './empresas.repositorio.js';
import type { FilaEmpresa, FilaPerfilEmpresa } from './empresas.repositorio.js';

const CODIGO_VALIDO = /^[A-Z0-9_-]{1,32}$/;

type Visibilidad = {
  // Los usuarios de inicio de sesión solo se muestran al personal del negocio.
  // El código del negocio es público (lo usan los clientes para reservar).
  incluirUsuarios: boolean;
};

export const crearServicioEmpresas = ({ pool }: { pool: pg.Pool }) => {
  const armarNegocio = async (empresa: FilaEmpresa, { incluirUsuarios }: Visibilidad) => {
    const [barberos, servicios] = await Promise.all([
      repositorio.listarBarberos(pool, empresa.id),
      repositorio.listarServicios(pool, empresa.id),
    ]);

    return {
      empresa: {
        id: empresa.id,
        nombre: empresa.nombre,
        codigoAcceso: empresa.codigo_acceso,
        colorPrimario: empresa.color_primario,
        colorSecundario: empresa.color_secundario,
        // la base manda "08:00:00"; la app usa "08:00"
        horarioApertura: String(empresa.horario_apertura).slice(0, 5),
        horarioCierre: String(empresa.horario_cierre).slice(0, 5),
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
        foto: b.foto_url ?? undefined,
      })),
      servicios: servicios.map((s) => ({
        id: s.id,
        nombre: s.nombre,
        duracion: `${s.duracion_min} min`,
        precio: Number(s.precio),
      })),
    };
  };

  return {
    // Vista pública para clientes que reservan con el código del negocio
    async negocioPorCodigo(codigo: string) {
      const limpio = codigo.trim().toUpperCase();
      const empresa = CODIGO_VALIDO.test(limpio)
        ? await repositorio.buscarEmpresaPorCodigo(pool, limpio)
        : undefined;
      if (!empresa) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarNegocio(empresa, { incluirUsuarios: false });
    },

    // Vista para el personal con sesión iniciada: su propio negocio
    async negocioDeSesion(empresaId: string) {
      const empresa = await repositorio.buscarEmpresaPorId(pool, empresaId);
      if (!empresa) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarNegocio(empresa, { incluirUsuarios: true });
    },

    // Perfil de la empresa del administrador. El id sale siempre de la sesión.
    async perfilDeAdmin(empresaId: string) {
      const perfil = await repositorio.buscarPerfilEmpresa(pool, empresaId);
      if (!perfil) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarPerfil(perfil);
    },

    async actualizarPerfil(empresaId: string, cambios: CambiosEmpresa) {
      const perfil = await repositorio.actualizarPerfilEmpresa(pool, empresaId, cambios).catch(traducirErrorPerfil);
      if (!perfil) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarPerfil(perfil);
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

// "08:00:00" de la base → "08:00" como lo usa la app
const horaCorta = (hora: string) => String(hora).slice(0, 5);

const armarPerfil = (p: FilaPerfilEmpresa) => ({
  id: p.id,
  nombre: p.nombre,
  codigoAcceso: p.codigo_acceso,
  categoria: p.categoria,
  nit: p.nit,
  telefono: p.telefono,
  correo: p.correo,
  direccion: p.direccion,
  ciudad: p.ciudad,
  diasAtencion: p.dias_atencion,
  horarioApertura: horaCorta(p.horario_apertura),
  horarioCierre: horaCorta(p.horario_cierre),
  nombreAdministradora: p.nombre_administradora,
  numeroEmpleados: p.numero_empleados,
  logoUrl: p.logo_url,
  colorPrimario: p.color_primario,
  colorSecundario: p.color_secundario,
  estadoSuscripcion: p.estado_suscripcion,
  trialEndsAt: p.trial_ends_at,
  creadaEn: p.created_at,
});

// Lo que la validación no puede saber sin mirar la base: el NIT de otra empresa
// o una hora que queda antes de la otra hora ya guardada
const traducirErrorPerfil = (error: unknown): never => {
  const restriccion = (error as { constraint?: string }).constraint;
  if (esErrorPg(error, CODIGO_PG.violacionUnica) && restriccion === 'empresas_nit_key') {
    throw errores.conflicto('Ya existe una empresa registrada con ese NIT');
  }
  if (esErrorPg(error, CODIGO_PG.violacionCheck) && restriccion === 'empresas_horario_valido') {
    throw errores.solicitudInvalida(MENSAJE_HORARIO);
  }
  throw error;
};

export type ServicioEmpresas = ReturnType<typeof crearServicioEmpresas>;
