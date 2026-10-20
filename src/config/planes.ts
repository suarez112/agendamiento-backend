// Planes por tamaño de equipo. Cada plan se paga mensual o anual.
// PRECIOS DE EJEMPLO en pesos colombianos (COP): cámbialos por los reales.
// El cupo es el máximo de integrantes activos en Equipo (la cuenta de correo de la
// administradora no cuenta, salvo que también esté agregada como integrante).
export const PLANES = [
  { id: 'basico', nombre: 'Básico', cupo: 3, precioMensual: 30000, precioAnual: 300000 },
  { id: 'equipo', nombre: 'Equipo', cupo: 5, precioMensual: 50000, precioAnual: 500000 },
  { id: 'pro', nombre: 'Pro', cupo: 10, precioMensual: 80000, precioAnual: 800000 },
] as const;

export type IdPlan = (typeof PLANES)[number]['id'];
export type Plan = (typeof PLANES)[number];

export const ID_PLANES = PLANES.map((p) => p.id) as IdPlan[];

export const buscarPlan = (id: string): Plan | undefined => PLANES.find((p) => p.id === id);

// Plan cuyo cupo alcanza para esa cantidad de personas (el más pequeño posible).
// Con más de 10 se usa el plan más grande.
export const planParaPersonas = (personas: number): Plan =>
  PLANES.find((p) => p.cupo >= personas) ?? PLANES[PLANES.length - 1];

// Plan que sigue (para invitar a subir de plan); undefined si ya es el más grande
export const planSiguiente = (id: string): Plan | undefined => PLANES[PLANES.findIndex((p) => p.id === id) + 1];
