import { Router } from 'express';
import { z } from 'zod';
import { esquemaId } from '../../shared/http/esquemas.js';
import { parsear } from '../../shared/http/validacion.js';
import { tokenDe } from '../auth/guardias.js';
import type { crearResolverTitular } from './dispositivos.rutas.js';
import type { ServicioNotificaciones } from './notificaciones.servicio.js';

const MENSAJE_PAGINA = 'La página debe ser un número entero desde 1';
const MENSAJE_LIMITE = 'El límite debe ser un número entero entre 1 y 100';

const esquemaLista = z.object({
  pagina: z.coerce.number({ error: MENSAJE_PAGINA }).int(MENSAJE_PAGINA).min(1, MENSAJE_PAGINA).max(100_000, MENSAJE_PAGINA).default(1),
  limite: z.coerce.number({ error: MENSAJE_LIMITE }).int(MENSAJE_LIMITE).min(1, MENSAJE_LIMITE).max(100, MENSAJE_LIMITE).default(25),
  soloNoLeidas: z
    .enum(['true', 'false'], { error: 'El filtro "soloNoLeidas" debe ser true o false' })
    .default('false')
    .transform((v) => v === 'true'),
});
const esquemaIdNotificacion = esquemaId('Identificador de notificación inválido');

// Centro de notificaciones: sirve a cualquier sesión (personal, administradora o cliente con
// cuenta). Cada quien ve solo las suyas; el dueño sale siempre de la sesión.
export const crearRutasNotificaciones = (
  notificaciones: ServicioNotificaciones,
  titularDe: ReturnType<typeof crearResolverTitular>,
) => {
  const rutas = Router();

  rutas.get('/', async (req, res) => {
    const titular = await titularDe(tokenDe(req));
    res.json(await notificaciones.listar(titular, parsear(esquemaLista, req.query)));
  });

  rutas.get('/no-leidas', async (req, res) => {
    res.json(await notificaciones.contarNoLeidas(await titularDe(tokenDe(req))));
  });

  // Antes de /:id/leida para que "leidas" no se tome como un identificador
  rutas.patch('/leidas', async (req, res) => {
    res.json(await notificaciones.marcarTodasLeidas(await titularDe(tokenDe(req))));
  });

  rutas.patch('/:id/leida', async (req, res) => {
    const titular = await titularDe(tokenDe(req));
    const { id } = parsear(esquemaIdNotificacion, req.params);
    res.json(await notificaciones.marcarLeida(titular, id));
  });

  return rutas;
};
