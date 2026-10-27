// Funciones que incluye cada plan. TODO se decide en esta tabla: para mover una función de plan,
// cambia su "planMinimo" (la incluyen ese plan y los más grandes).
import { buscarPlan, nivelDePlan, type IdPlan, type Plan } from './planes.js';

export const FUNCIONES = {
  // ---- Todos los planes ----
  agenda: { nombre: 'Agenda', planMinimo: 'emprendedor' },
  reservas: { nombre: 'Reservas', planMinimo: 'emprendedor' },
  recordatorios: { nombre: 'Recordatorios', planMinimo: 'emprendedor' },
  enlace_y_qr: { nombre: 'Enlace y QR del negocio', planMinimo: 'emprendedor' },
  notificaciones: { nombre: 'Notificaciones', planMinimo: 'emprendedor' },
  clientes: { nombre: 'Clientes', planMinimo: 'emprendedor' },
  lista_bloqueados: { nombre: 'Lista de bloqueados', planMinimo: 'emprendedor' },
  catalogo_productos: { nombre: 'Catálogo de productos', planMinimo: 'emprendedor' },
  // Ventas, ganancias, ticket promedio y servicios más vendidos
  cartera_basica: { nombre: 'Cartera básica', planMinimo: 'emprendedor' },
  // ---- Equipo y Pro ----
  roles: { nombre: 'Roles de administrador y empleado', planMinimo: 'equipo' },
  comisiones: { nombre: 'Comisiones y pago a profesionales', planMinimo: 'equipo' },
  ocupacion_profesional: { nombre: 'Ocupación por profesional', planMinimo: 'equipo' },
  comparar_periodos: { nombre: 'Comparar con otros períodos', planMinimo: 'equipo' },
  demanda: { nombre: 'Demanda por día y hora', planMinimo: 'equipo' },
  // ---- Solo Pro ----
  servicios_rentables: { nombre: 'Servicios más rentables', planMinimo: 'pro' },
  reportes_avanzados: { nombre: 'Reportes avanzados', planMinimo: 'pro' },
  exportar_reportes: { nombre: 'Exportar reportes', planMinimo: 'pro' },
} as const satisfies Record<string, { nombre: string; planMinimo: IdPlan }>;

export type IdFuncion = keyof typeof FUNCIONES;

export const incluyeFuncion = (planId: string, funcion: IdFuncion) =>
  nivelDePlan(planId) >= nivelDePlan(FUNCIONES[funcion].planMinimo);

// Plan más pequeño que incluye la función
export const planDeFuncion = (funcion: IdFuncion): Plan => buscarPlan(FUNCIONES[funcion].planMinimo) as Plan;
