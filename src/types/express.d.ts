import type { Sesion } from '../modules/auth/auth.servicio.js';
import type { SesionCuenta } from '../modules/cuentas/cuentas.servicio.js';

declare global {
  namespace Express {
    interface Locals {
      sesion?: Sesion; // personal (barberos)
      cuenta?: SesionCuenta; // administrador de empresa o cliente
    }
  }
}

export {};
