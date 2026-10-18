import type { Request, RequestHandler, Response } from 'express';
import { errores } from '../../shared/errores.js';
import type { Sesion, ServicioAuth } from './auth.servicio.js';

// Token enviado como "Authorization: Bearer <token>"
export const tokenDe = (req: Request): string | undefined => {
  const encabezado = req.headers.authorization;
  return encabezado?.startsWith('Bearer ') ? encabezado.slice(7) : undefined;
};

// Middlewares de permisos. Los datos del negocio y del barbero salen siempre
// de la sesión, nunca de lo que envíe la app.
export const crearGuardias = (auth: ServicioAuth) => {
  const requerirSesion: RequestHandler = async (req, res, next) => {
    res.locals.sesion = await auth.validarSesion(tokenDe(req));
    next();
  };

  const requerirAdmin =
    (mensaje: string): RequestHandler =>
    (_req, res, next) => {
      if (!sesionDe(res).esAdmin) throw errores.prohibido(mensaje);
      next();
    };

  return { requerirSesion, requerirAdmin };
};

export type Guardias = ReturnType<typeof crearGuardias>;

export const sesionDe = (res: Response): Sesion => {
  const sesion = res.locals.sesion;
  if (!sesion) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
  return sesion;
};
