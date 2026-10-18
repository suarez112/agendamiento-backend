import type { Sesion } from '../modules/auth/auth.servicio.js';

declare global {
  namespace Express {
    interface Locals {
      sesion?: Sesion;
    }
  }
}

export {};
