import type { RequestHandler, Response } from 'express';
import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import { buscarSuscripcion } from './empresas.repositorio.js';

// Duración de la prueba gratuita de una empresa nueva
export const DIAS_PRUEBA = 15;

// Mensaje según el estado de la suscripción cuando ya no permite entrar
const MENSAJE_BLOQUEO: Record<string, string> = {
  trial: `Tu prueba gratuita de ${DIAS_PRUEBA} días terminó. Activa tu suscripción para seguir usando las funciones de administrador.`,
  vencida: 'La suscripción de tu empresa venció. Renuévala para seguir usando las funciones de administrador.',
  cancelada: 'La suscripción de tu empresa está cancelada. Actívala para seguir usando las funciones de administrador.',
};

// Empresa de la sesión, sea de una cuenta de administrador o del personal (barberos)
const empresaDeSesion = (res: Response): string => {
  const empresaId = res.locals.cuenta?.empresaId ?? res.locals.sesion?.empresaId;
  if (!empresaId) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
  return empresaId;
};

// Middleware para los endpoints de administrador. Va después de la guardia que
// exige sesión de administrador. Responde 402 si la prueba gratuita venció o
// la suscripción no está activa.
export const crearGuardiaSuscripcion = ({ pool }: { pool: pg.Pool }) => {
  const requerirSuscripcionVigente: RequestHandler = async (_req, res, next) => {
    const suscripcion = await buscarSuscripcion(pool, empresaDeSesion(res));
    if (!suscripcion) throw errores.noEncontrado('Establecimiento no encontrado');
    if (!suscripcion.habilitada) {
      throw errores.pagoRequerido(MENSAJE_BLOQUEO[suscripcion.estado_suscripcion] ?? MENSAJE_BLOQUEO.vencida);
    }
    next();
  };

  return { requerirSuscripcionVigente };
};

export type GuardiaSuscripcion = ReturnType<typeof crearGuardiaSuscripcion>;
