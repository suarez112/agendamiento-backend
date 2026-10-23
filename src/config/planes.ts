// Planes por tamaño de equipo. Cada plan se paga mensual o anual.
// PRECIOS DE EJEMPLO en pesos colombianos (COP): cambia aquí el precio mensual por el real.
// El precio anual sale solo: el mensual × 12 con DESCUENTO_ANUAL.
// El cupo es el máximo de integrantes activos en Equipo (incluida la administradora si también atiende clientes).
// Las funciones de cada plan están en src/config/funciones.ts.
export const DESCUENTO_ANUAL = 0.1;

const DEFINICION = [
  { id: 'emprendedor', nombre: 'Emprendedor', cupo: 1, personasDesde: 1, precioMensual: 30000 },
  { id: 'equipo', nombre: 'Equipo', cupo: 5, personasDesde: 2, precioMensual: 60000 },
  { id: 'pro', nombre: 'Pro', cupo: 10, personasDesde: 6, precioMensual: 100000 },
] as const;

export type IdPlan = (typeof DEFINICION)[number]['id'];
export type Plan = (typeof DEFINICION)[number] & { precioAnual: number };

export const precioAnualDe = (precioMensual: number) => Math.round(precioMensual * 12 * (1 - DESCUENTO_ANUAL));

export const PLANES: readonly Plan[] = DEFINICION.map((p) => ({ ...p, precioAnual: precioAnualDe(p.precioMensual) }));

export const ID_PLANES = PLANES.map((p) => p.id) as [IdPlan, ...IdPlan[]];

export const buscarPlan = (id: string): Plan | undefined => PLANES.find((p) => p.id === id);

// Plan cuyo cupo alcanza para esa cantidad de personas (el más pequeño posible).
// Con más de 10 se usa el plan más grande.
export const planParaPersonas = (personas: number): Plan =>
  PLANES.find((p) => p.cupo >= personas) ?? PLANES[PLANES.length - 1];

// Plan que sigue (para invitar a subir de plan); undefined si ya es el más grande
export const planSiguiente = (id: string): Plan | undefined => PLANES[PLANES.findIndex((p) => p.id === id) + 1];

// Posición del plan de menor a mayor (para comparar planes)
export const nivelDePlan = (id: string) => PLANES.findIndex((p) => p.id === id);
