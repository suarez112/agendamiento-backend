import type { RequestHandler } from 'express';
import type { GuardiaSuscripcion } from '../empresas/suscripcion.js';
import type { Guardias } from './guardias.js';

export const SOLO_ADMIN = 'Solo el administrador del negocio puede usar esta función.';

// Combinaciones de guardias para los endpoints de gestión del negocio. Sirven
// para el personal (barberos) y para la cuenta del administrador de la empresa.
// Todas exigen la suscripción vigente: con la prueba vencida responden 402.
export const crearPermisos = (guardias: Guardias, suscripcion: GuardiaSuscripcion) => ({
  // Cualquier persona del equipo con sesión
  personal: [guardias.requerirSesion, suscripcion.requerirSuscripcionVigente] as RequestHandler[],
  // Solo administradores (barbero administrador o la cuenta de la empresa)
  admin: [
    guardias.requerirSesion,
    guardias.requerirAdmin(SOLO_ADMIN),
    suscripcion.requerirSuscripcionVigente,
  ] as RequestHandler[],
});

export type Permisos = ReturnType<typeof crearPermisos>;
