import { Router } from 'express';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { parsear } from '../../shared/http/validacion.js';
import { type Guardias, sesionDe } from '../auth/guardias.js';
import type { GuardiaSuscripcion } from '../empresas/suscripcion.js';
import { esquemaCrearCita, esquemaHorasOcupadas, esquemaIdCita } from './citas.esquemas.js';
import type { ServicioCitas } from './citas.servicio.js';

export const crearRutasCitas = (
  citas: ServicioCitas,
  guardias: Guardias,
  suscripcion: GuardiaSuscripcion,
  limitadores: Limitadores,
) => {
  const rutas = Router();
  const { requerirSesion, requerirAdmin } = guardias;

  // Públicas: las usan los clientes que reservan
  rutas.post('/', limitadores.reservas, async (req, res) => {
    res.status(201).json(await citas.crear(parsear(esquemaCrearCita, req.body)));
  });

  rutas.get('/ocupadas', async (req, res) => {
    const { empresaId } = parsear(esquemaHorasOcupadas, req.query);
    res.json(await citas.horasOcupadas(empresaId));
  });

  rutas.get('/bloqueos', async (req, res) => {
    const { empresaId } = parsear(esquemaHorasOcupadas, req.query);
    res.json(await citas.bloqueosPublicos(empresaId));
  });

  // Personal con sesión iniciada (barberos o la cuenta del administrador de la empresa)
  rutas.get('/agenda', requerirSesion, async (_req, res) => {
    res.json(await citas.agenda(sesionDe(res)));
  });

  rutas.patch('/:id/completar', requerirSesion, async (req, res) => {
    const { id } = parsear(esquemaIdCita, req.params);
    res.json(await citas.completar(sesionDe(res), id));
  });

  rutas.patch(
    '/:id/cancelar',
    requerirSesion,
    requerirAdmin('Solo el administrador puede cancelar citas.'),
    suscripcion.requerirSuscripcionVigente,
    async (req, res) => {
      const { id } = parsear(esquemaIdCita, req.params);
      res.json(await citas.cancelar(sesionDe(res), id));
    },
  );

  return rutas;
};
