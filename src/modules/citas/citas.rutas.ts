import { Router } from 'express';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { parsear } from '../../shared/http/validacion.js';
import { type Guardias, sesionDe, tokenDe } from '../auth/guardias.js';
import type { ServicioCuentas } from '../cuentas/cuentas.servicio.js';
import type { GuardiaSuscripcion } from '../empresas/suscripcion.js';
import { esquemaCrearCita, esquemaHorasOcupadas, esquemaIdCita } from './citas.esquemas.js';
import type { ServicioCitas } from './citas.servicio.js';

export const crearRutasCitas = (
  citas: ServicioCitas,
  guardias: Guardias,
  suscripcion: GuardiaSuscripcion,
  limitadores: Limitadores,
  cuentas: ServicioCuentas,
) => {
  const rutas = Router();
  const { requerirSesion, requerirAdmin } = guardias;

  // Públicas: las usan los clientes que reservan. Con el token de una cuenta de
  // cliente se usan su nombre y teléfono; sin token (o con otro) es una reserva de invitado.
  rutas.post('/', limitadores.reservas, async (req, res) => {
    const datos = parsear(esquemaCrearCita, req.body);
    res.status(201).json(await citas.crear(datos, await cuentas.clienteDeToken(tokenDe(req))));
  });

  rutas.get('/ocupadas', async (req, res) => {
    const { empresaId } = parsear(esquemaHorasOcupadas, req.query);
    res.json(await citas.horasOcupadas(empresaId));
  });

  rutas.get('/bloqueos', async (req, res) => {
    const { empresaId } = parsear(esquemaHorasOcupadas, req.query);
    res.json(await citas.bloqueosPublicos(empresaId));
  });

  // Personal con sesión iniciada (barberos o la cuenta del administrador de la empresa).
  // Con la suscripción vencida responden 402 (al empleado: negocio inactivo).
  const sesionVigente = [requerirSesion, suscripcion.requerirSuscripcionVigente];

  rutas.get('/agenda', ...sesionVigente, async (_req, res) => {
    res.json(await citas.agenda(sesionDe(res)));
  });

  rutas.patch('/:id/completar', ...sesionVigente, async (req, res) => {
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
