import { ZONA_POR_DEFECTO, esZonaValida, zonaCanonica } from '../shared/zonaHoraria.js';

// Zona horaria de la plataforma: solo para lo que no pertenece a ningún negocio (año del radicado de
// las PQRS, fechas del registro de actividad del superadmin y los gráficos de toda la plataforma).
// Cada negocio usa la suya (empresas.zona_horaria). Variable opcional ZONA_PLATAFORMA.
const pedida = process.env.ZONA_PLATAFORMA?.trim() || ZONA_POR_DEFECTO;
if (!esZonaValida(pedida)) throw new Error(`ZONA_PLATAFORMA no es una zona horaria válida: ${pedida}`);

// Ya validada (solo letras, números y _+-/): es seguro escribirla dentro de una consulta SQL
export const ZONA_PLATAFORMA = zonaCanonica(pedida);
if (!/^[A-Za-z0-9_+/-]+$/.test(ZONA_PLATAFORMA)) throw new Error('ZONA_PLATAFORMA contiene caracteres no permitidos');
