import { Router } from 'express';
import { z } from 'zod';
import { texto } from '../../shared/http/esquemas.js';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { parsear } from '../../shared/http/validacion.js';
import { tokenDe } from '../auth/guardias.js';
import { cuentaDe, type GuardiasCuenta } from '../cuentas/cuentas.guardias.js';
import type { ServicioCuentas } from '../cuentas/cuentas.servicio.js';
import { TIPOS_PQRS } from './pqrs.repositorio.js';
import type { ServicioPqrs } from './pqrs.servicio.js';

const MENSAJE_TIPO = 'El tipo debe ser "peticion", "queja", "reclamo" o "sugerencia"';

const esquemaPqrs = z.object(
  {
    tipo: z.enum(TIPOS_PQRS, { error: MENSAJE_TIPO }),
    mensaje: texto('mensaje', 2000),
    nombre: texto('nombre', 100).optional(),
    contacto: texto('contacto', 150).optional(),
  },
  { error: 'Envía el tipo y el mensaje de tu PQRS' },
);

export const crearRutasPqrs = (
  pqrs: ServicioPqrs,
  cuentas: ServicioCuentas,
  guardias: GuardiasCuenta,
  limitadores: Limitadores,
) => {
  const rutas = Router();

  // Público: sirve como invitado o con la sesión de una administradora o un cliente
  rutas.post('/', limitadores.pqrs, async (req, res) => {
    const datos = parsear(esquemaPqrs, req.body);
    // Un token vencido o inválido no bloquea: la PQRS se radica como invitado
    const cuenta = await cuentas.cuentaDeToken(tokenDe(req));
    res.status(201).json(await pqrs.radicar(datos, cuenta));
  });

  // Las PQRS que radicó con su sesión
  rutas.get('/mias', guardias.requerirCuenta, async (_req, res) => {
    res.json(await pqrs.deUsuario(cuentaDe(res).usuarioId));
  });

  return rutas;
};
