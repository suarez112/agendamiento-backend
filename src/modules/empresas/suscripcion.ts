import type { RequestHandler, Response } from 'express';
import type pg from 'pg';
import type { Plan } from '../../config/planes.js';
import { errores } from '../../shared/errores.js';
import { buscarSuscripcion, type FilaSuscripcion } from './empresas.repositorio.js';

// Duración de la prueba gratuita de una empresa nueva
export const DIAS_PRUEBA = 15;

// En los últimos días de un plan mensual o anual se muestra un recordatorio
export const DIAS_RECORDATORIO = 7;

// Aviso para el personal (no administrador) de un negocio con la suscripción vencida
export const NEGOCIO_INACTIVO = 'Este negocio está inactivo por ahora. Comunícate con el administrador del negocio.';

// Aviso para los clientes que intentan reservar en un negocio con la suscripción vencida
export const SIN_RESERVAS = 'Este negocio no está recibiendo reservas por ahora';

// Cambiar a un plan cuyo cupo no alcanza para el equipo activo se rechaza
export const planInsuficiente = (plan: Plan, activos: number) =>
  `Tu equipo tiene ${activos} integrante(s) activo(s) y el plan ${plan.nombre} permite hasta ${plan.cupo}. Elimina primero del equipo a quien ya no trabaje en el negocio, o elige un plan más grande.`;

// Aviso cuando el superadmin suspendió el negocio (se comporta como vencido)
export const NEGOCIO_SUSPENDIDO = 'Negocio suspendido; contacta a soporte';

// Mensaje para el administrador según el estado guardado cuando ya no permite entrar.
// Un plan 'activa' cuya fecha de fin ya pasó es una suscripción vencida.
const MENSAJE_BLOQUEO: Record<string, string> = {
  trial: `Tu prueba gratuita de ${DIAS_PRUEBA} días terminó. Activa tu suscripción para seguir usando las funciones de administrador.`,
  vencida: 'La suscripción de tu empresa venció. Renuévala para seguir usando las funciones de administrador.',
  cancelada: 'La suscripción de tu empresa está cancelada. Actívala para seguir usando las funciones de administrador.',
};

export const mensajeBloqueo = (s: FilaSuscripcion) =>
  s.suspendida ? NEGOCIO_SUSPENDIDO : MENSAJE_BLOQUEO[s.estado_suscripcion] ?? MENSAJE_BLOQUEO.vencida;

// Estado que ve la app: prueba, activa o vencida
export const estadoEfectivo = (s: FilaSuscripcion): 'prueba' | 'activa' | 'vencida' => {
  if (!s.habilitada) return 'vencida';
  return s.estado_suscripcion === 'trial' ? 'prueba' : 'activa';
};

// Empresa de la sesión, sea de una cuenta de administrador o del personal (barberos)
const empresaDeSesion = (res: Response): string => {
  const empresaId = res.locals.cuenta?.empresaId ?? res.locals.sesion?.empresaId;
  if (!empresaId) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
  return empresaId;
};

// Middleware que va después de la guardia de sesión. Responde 402 si la prueba
// gratuita o el plan vencieron: al administrador le dice que active su
// suscripción; a un empleado, que el negocio está inactivo.
export const crearGuardiaSuscripcion = ({ pool }: { pool: pg.Pool }) => {
  const requerirSuscripcionVigente: RequestHandler = async (_req, res, next) => {
    const suscripcion = await buscarSuscripcion(pool, empresaDeSesion(res));
    if (!suscripcion) throw errores.noEncontrado('Establecimiento no encontrado');
    if (!suscripcion.habilitada) {
      const esEmpleado = res.locals.sesion?.esAdmin === false;
      throw errores.pagoRequerido(esEmpleado ? NEGOCIO_INACTIVO : mensajeBloqueo(suscripcion));
    }
    next();
  };

  return { requerirSuscripcionVigente };
};

export type GuardiaSuscripcion = ReturnType<typeof crearGuardiaSuscripcion>;
