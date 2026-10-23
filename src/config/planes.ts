// Cobro por profesional y niveles automáticos. PRECIOS DE EJEMPLO en pesos colombianos (COP):
// cambia aquí los valores por los reales.
// Se cobra por cada integrante activo que atiende clientes (incluida la cuenta de administración si activó
// "Yo también atiendo clientes"). Los administradores que no atienden no se cobran (hasta 2 por negocio).
// El precio anual sale solo: el mensual × 12 con DESCUENTO_ANUAL.
// El nivel (Emprendedor, Equipo, Pro) sale solo de cuántos profesionales se cobran; sus funciones están
// en src/config/funciones.ts.
export const DESCUENTO_ANUAL = 0.1;

export const COBRO = {
  // Mensual: el primer profesional y cada uno adicional
  precioPrimerProfesional: 35000,
  precioProfesionalAdicional: 25000,
  // Máximo de profesionales cobrados por negocio
  maxProfesionales: 10,
  // Administradores que no atienden clientes (no se cobran) permitidos por negocio
  maxAdminsSinAtender: 2,
  // Cargo mínimo al agregar un profesional a mitad del periodo
  cargoProporcionalMinimo: 10000,
} as const;

// Comisión de la pasarela de pagos por transacción: porcentaje + valor fijo, y IVA sobre esa comisión
export const COMISION_PASARELA = { porcentaje: 0.0265, fijo: 700, iva: 0.19 } as const;

// Comisión estimada (con IVA) de cobrar una suma en una sola transacción
export const comisionPasarela = (bruto: number, transacciones = 1) =>
  Math.round((bruto * COMISION_PASARELA.porcentaje + COMISION_PASARELA.fijo * transacciones) * (1 + COMISION_PASARELA.iva));

// Niveles: "profesionalesDesde" y "cupo" (hasta) son el rango de profesionales cobrados de cada nivel
const DEFINICION = [
  { id: 'emprendedor', nombre: 'Emprendedor', personasDesde: 1, cupo: 1 },
  { id: 'equipo', nombre: 'Equipo', personasDesde: 2, cupo: 5 },
  { id: 'pro', nombre: 'Pro', personasDesde: 6, cupo: 10 },
] as const;

export type IdPlan = (typeof DEFINICION)[number]['id'];
export type Plan = (typeof DEFINICION)[number];
export type Periodo = 'mensual' | 'anual';

export const precioAnualDe = (precioMensual: number) => Math.round(precioMensual * 12 * (1 - DESCUENTO_ANUAL));

// Precio mensual del puesto k-ésimo (el 1.º es más caro que los adicionales)
export const precioPuestoMensual = (k: number) =>
  k <= 1 ? COBRO.precioPrimerProfesional : COBRO.precioProfesionalAdicional;

// Un negocio paga como mínimo un profesional
export const precioMensualPara = (profesionales: number) => {
  let total = 0;
  for (let k = 1; k <= Math.max(profesionales, 1); k++) total += precioPuestoMensual(k);
  return total;
};

export const precioPara = (profesionales: number, periodo: Periodo) => {
  const mensual = precioMensualPara(profesionales);
  return periodo === 'mensual' ? mensual : precioAnualDe(mensual);
};

// Precio de un solo puesto (el k-ésimo) en el periodo
export const precioPuesto = (k: number, periodo: Periodo) => {
  const mensual = precioPuestoMensual(k);
  return periodo === 'mensual' ? mensual : precioAnualDe(mensual);
};

export const PLANES: readonly Plan[] = DEFINICION;

export const ID_PLANES = PLANES.map((p) => p.id) as [IdPlan, ...IdPlan[]];

export const buscarPlan = (id: string): Plan | undefined => PLANES.find((p) => p.id === id);

// Nivel que corresponde a esa cantidad de profesionales (con más de 10 se usa el más grande)
export const planParaPersonas = (personas: number): Plan =>
  PLANES.find((p) => p.cupo >= personas) ?? PLANES[PLANES.length - 1];

// Nivel que sigue (para invitar a subir); undefined si ya es el más grande
export const planSiguiente = (id: string): Plan | undefined => PLANES[PLANES.findIndex((p) => p.id === id) + 1];

// Posición del nivel de menor a mayor (para comparar niveles)
export const nivelDePlan = (id: string) => PLANES.findIndex((p) => p.id === id);
