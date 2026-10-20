import { Router } from 'express';
import { z } from 'zod';
import { fecha } from '../../shared/http/esquemas.js';
import { parsear } from '../../shared/http/validacion.js';
import { sesionDe } from '../auth/guardias.js';
import type { Permisos } from '../auth/permisos.js';
import type { ServicioCartera } from './cartera.servicio.js';

const MAX_DIAS = 366;
const DIA_MS = 86_400_000;

const MENSAJE_BARBERO = 'Identificador de profesional inválido';

// Solo para administradores: la cartera de un integrante (también la propia)
const esquemaBarbero = z
  .string({ error: MENSAJE_BARBERO })
  .trim()
  .min(1, MENSAJE_BARBERO)
  .max(64, MENSAJE_BARBERO)
  .optional();

const camposRango = { desde: fecha('desde'), hasta: fecha('hasta'), barberoId: esquemaBarbero };

// "AAAA-MM-DD" se compara bien como texto
const conRangoValido = <T extends z.ZodType<{ desde: string; hasta: string }>>(esquema: T) =>
  esquema
    .refine((r) => r.hasta >= r.desde, 'La fecha "hasta" no puede ser anterior a "desde"')
    .refine(
      (r) => (Date.parse(r.hasta) - Date.parse(r.desde)) / DIA_MS < MAX_DIAS,
      `El rango no puede ser mayor que ${MAX_DIAS} días`,
    );

const esquemaRango = conRangoValido(z.object(camposRango, { error: 'Envía las fechas "desde" y "hasta"' }));

const MENSAJE_PERIODO = 'Elige el período en "periodo": "hoy", "semana", "mes" o "rango" (con "desde" y "hasta")';

// Resumen por período: hoy, semana (lunes a domingo), mes, o rango con desde y hasta
const esquemaPeriodo = z.discriminatedUnion(
  'periodo',
  [
    z.object({ periodo: z.enum(['hoy', 'semana', 'mes']), barberoId: esquemaBarbero }),
    conRangoValido(z.object({ periodo: z.literal('rango'), ...camposRango })),
  ],
  { error: MENSAJE_PERIODO },
);

const MENSAJE_COMPARAR =
  'Elige con qué comparar en "comparar": "anterior", "mes_pasado", "anio_pasado" o "personalizado" (con "compararDesde" y "compararHasta")';

// Con qué período se compara el resumen. Sin "comparar" se usa el período anterior.
// "personalizado" pide las dos fechas; en los demás tipos se ignoran.
const esquemaComparacion = z
  .object({
    comparar: z.enum(['anterior', 'mes_pasado', 'anio_pasado', 'personalizado'], { error: MENSAJE_COMPARAR }).default('anterior'),
    compararDesde: fecha('compararDesde').optional(),
    compararHasta: fecha('compararHasta').optional(),
  })
  .refine(
    (c) => c.comparar !== 'personalizado' || (c.compararDesde && c.compararHasta),
    'Envía "compararDesde" y "compararHasta" para comparar con un rango personalizado',
  )
  .refine(
    (c) => c.comparar !== 'personalizado' || !c.compararDesde || !c.compararHasta || c.compararHasta >= c.compararDesde,
    'La fecha "compararHasta" no puede ser anterior a "compararDesde"',
  )
  .refine(
    (c) =>
      c.comparar !== 'personalizado' ||
      !c.compararDesde ||
      !c.compararHasta ||
      (Date.parse(c.compararHasta) - Date.parse(c.compararDesde)) / DIA_MS < MAX_DIAS,
    `El rango de comparación no puede ser mayor que ${MAX_DIAS} días`,
  )
  .transform((c) =>
    c.comparar === 'personalizado'
      ? { tipo: c.comparar, desde: c.compararDesde as string, hasta: c.compararHasta as string }
      : { tipo: c.comparar },
  );

// Cartera: ganancias del negocio de la sesión entre dos fechas
export const crearRutasCartera = (cartera: ServicioCartera, permisos: Permisos) => {
  const rutas = Router();

  rutas.get('/resumen', ...permisos.personal, async (req, res) => {
    const consulta = parsear(esquemaPeriodo, req.query);
    const comparacion = parsear(esquemaComparacion, req.query);
    res.json(await cartera.resumenPeriodo(sesionDe(res), consulta, comparacion));
  });

  rutas.get('/', ...permisos.personal, async (req, res) => {
    const { desde, hasta, barberoId } = parsear(esquemaRango, req.query);
    res.json(await cartera.resumen(sesionDe(res), desde, hasta, barberoId));
  });

  return rutas;
};
