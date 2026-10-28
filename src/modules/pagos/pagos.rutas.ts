import { Router } from 'express';
import { z } from 'zod';
import { COBRO } from '../../config/planes.js';
import { errores } from '../../shared/errores.js';
import { parsear } from '../../shared/http/validacion.js';
import { type Guardias, sesionDe } from '../auth/guardias.js';
import { SOLO_ADMIN } from '../auth/permisos.js';
import type { ServicioPagos } from './pagos.servicio.js';
import type { ProveedorPago } from './proveedor.js';

const esquemaOrden = z.object({
  profesionales: z
    .number({ error: 'Indica cuántos profesionales quieres pagar' })
    .int('El número de profesionales debe ser un número entero')
    .min(1, 'Un negocio paga como mínimo un profesional')
    .max(COBRO.maxProfesionales, `Un negocio puede tener hasta ${COBRO.maxProfesionales} profesionales`),
  periodo: z.enum(['mensual', 'anual'], { error: 'El periodo debe ser "mensual" o "anual"' }),
});

const esquemaConfirmacion = z.object({ idTransaccion: z.string().trim().min(1).max(100).optional() }).optional();

// Pagos de la suscripción. Los administradores pagan también con la suscripción vencida (por eso no llevan la
// guardia de suscripción vigente, igual que Mi negocio y /suscripcion).
export const crearRutasPagos = (pagos: ServicioPagos, guardias: Guardias, proveedor?: ProveedorPago & { rutas?: () => Router }) => {
  const rutas = Router();
  const soloAdmin = [guardias.requerirSesion, guardias.requerirAdmin(SOLO_ADMIN)];

  // Webhook de la pasarela (público: la firma es la autenticación). Mientras no haya proveedor con webhook activo, 404.
  rutas.post('/webhook', async (req, res) => {
    if (!proveedor?.verificarEvento) throw errores.noEncontrado('Ruta no encontrada');
    if (!(await pagos.procesarEvento(req.body))) throw errores.noAutenticado('Firma del evento no válida');
    res.json({ recibido: true });
  });

  // Página de pago de pruebas (solo existe con el proveedor simulado, que no arranca en producción)
  if (proveedor?.rutas) rutas.use('/simulado', proveedor.rutas());

  rutas.post('/ordenes', ...soloAdmin, async (req, res) => {
    const datos = parsear(esquemaOrden, req.body);
    res.status(201).json(await pagos.crearOrden(sesionDe(res).empresaId, datos));
  });

  rutas.get('/ordenes/:referencia', ...soloAdmin, async (req, res) => {
    res.json(await pagos.consultar(sesionDe(res).empresaId, String(req.params.referencia)));
  });

  // Al volver del pago: el backend pregunta el estado a la pasarela (nunca confía en lo que diga la app)
  rutas.post('/ordenes/:referencia/confirmar', ...soloAdmin, async (req, res) => {
    const datos = parsear(esquemaConfirmacion, req.body);
    res.json(await pagos.confirmar(sesionDe(res).empresaId, String(req.params.referencia), datos?.idTransaccion));
  });

  return rutas;
};
