// Plazos de respuesta de las PQRS. Se cuentan en días hábiles (lunes a viernes; los festivos no se
// descuentan, así el plazo nunca queda más largo de lo prometido).
import type { IdPlan } from './planes.js';

// Prioridad (1 = la más urgente) y días hábiles para responder, según el plan del negocio de quien radica
export const PLAZO_POR_PLAN: Record<IdPlan, { prioridad: 1 | 2 | 3; diasHabiles: number }> = {
  emprendedor: { prioridad: 3, diasHabiles: 3 },
  equipo: { prioridad: 2, diasHabiles: 2 },
  pro: { prioridad: 1, diasHabiles: 1 },
};

// Quien radica sin negocio (invitado o cliente) recibe el plazo del plan más pequeño
export const PLAN_SIN_NEGOCIO: IdPlan = 'emprendedor';

// Ley 1581 de 2012 (habeas data): las consultas se responden en máximo 10 días hábiles y los reclamos
// en máximo 15. El plazo del plan nunca supera estos topes (hoy los planes son de 1 a 3 días, pero
// si algún día se amplían, un reclamo de datos personales no se pasa de la ley).
export const TOPE_LEY_1581_DIAS_HABILES = { peticion: 10, reclamo: 15 } as const;
const TOPE_POR_DEFECTO = 15;

export const diasHabilesParaResponder = (plan: IdPlan, tipo: string) =>
  Math.min(
    PLAZO_POR_PLAN[plan].diasHabiles,
    TOPE_LEY_1581_DIAS_HABILES[tipo as keyof typeof TOPE_LEY_1581_DIAS_HABILES] ?? TOPE_POR_DEFECTO,
  );
