import type { RequestHandler, Response } from 'express';
import { errores } from '../../shared/errores.js';
import { tokenDe } from '../auth/guardias.js';
import type { ServicioCuentas, SesionCuenta } from './cuentas.servicio.js';

// Middlewares para cuentas (administradores de empresa y clientes). La empresa
// y el rol salen siempre de la sesión, nunca de lo que envíe la app.
export const crearGuardiasCuenta = (cuentas: ServicioCuentas) => {
  const requerirCuenta: RequestHandler = async (req, res, next) => {
    res.locals.cuenta = await cuentas.validarSesion(tokenDe(req));
    next();
  };

  // Un cliente (o cualquier cuenta sin empresa) no entra a funciones de administrador
  const requerirAdminEmpresa: RequestHandler = (_req, res, next) => {
    const cuenta = cuentaDe(res);
    if (cuenta.rol !== 'admin' || !cuenta.empresaId) {
      throw errores.prohibido('Solo el administrador de una empresa puede usar esta función.');
    }
    next();
  };

  return { requerirCuenta, requerirAdminEmpresa };
};

export type GuardiasCuenta = ReturnType<typeof crearGuardiasCuenta>;

export const cuentaDe = (res: Response): SesionCuenta => {
  const cuenta = res.locals.cuenta;
  if (!cuenta) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
  return cuenta;
};

// Empresa del administrador con sesión (requerirAdminEmpresa ya garantizó que existe)
export const empresaDeAdmin = (res: Response): string => {
  const { empresaId } = cuentaDe(res);
  if (!empresaId) throw errores.prohibido('Solo el administrador de una empresa puede usar esta función.');
  return empresaId;
};
