import type { Consultable } from '../../db/pool.js';
import type { Sesion } from '../auth/auth.servicio.js';
import { buscarEmpleadosVenTelefono } from '../empresas/empresas.repositorio.js';

// ¿Esta sesión del personal puede recibir el teléfono (y el WhatsApp) de los clientes?
// Los administradores (integrante con rol Administrador o cuenta de administración) siempre; un empleado, solo si
// su negocio encendió "los empleados pueden ver el teléfono de los clientes" (migración 034, apagada por defecto).
// Se lee de la base en cada solicitud, así un cambio de la opción o del rol aplica en la siguiente solicitud.
// Si no se puede leer la opción, no se muestra (falla cerrado).
export const puedeVerTelefonos = async (db: Consultable, sesion: Sesion): Promise<boolean> =>
  sesion.esAdmin || (await buscarEmpleadosVenTelefono(db, sesion.empresaId)) === true;

// Toda respuesta al personal que incluya datos de contacto de un cliente pasa por aquí: sin permiso, null
export const telefonoVisible = <T extends string | null>(valor: T, ver: boolean): T | null => (ver ? valor : null);
