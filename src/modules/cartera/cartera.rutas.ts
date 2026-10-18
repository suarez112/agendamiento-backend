import { Router } from 'express';
import { z } from 'zod';
import { fecha } from '../../shared/http/esquemas.js';
import { parsear } from '../../shared/http/validacion.js';
import { sesionDe } from '../auth/guardias.js';
import type { Permisos } from '../auth/permisos.js';
import type { ServicioCartera } from './cartera.servicio.js';

const MAX_DIAS = 366;
const DIA_MS = 86_400_000;

const esquemaRango = z
  .object({ desde: fecha('desde'), hasta: fecha('hasta') }, { error: 'Envía las fechas "desde" y "hasta"' })
  // "AAAA-MM-DD" se compara bien como texto
  .refine((r) => r.hasta >= r.desde, 'La fecha "hasta" no puede ser anterior a "desde"')
  .refine(
    (r) => (Date.parse(r.hasta) - Date.parse(r.desde)) / DIA_MS < MAX_DIAS,
    `El rango no puede ser mayor que ${MAX_DIAS} días`,
  );

// Cartera: ganancias del negocio de la sesión entre dos fechas
export const crearRutasCartera = (cartera: ServicioCartera, permisos: Permisos) => {
  const rutas = Router();

  rutas.get('/', ...permisos.personal, async (req, res) => {
    const { desde, hasta } = parsear(esquemaRango, req.query);
    res.json(await cartera.resumen(sesionDe(res), desde, hasta));
  });

  return rutas;
};
