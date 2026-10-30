import { type RequestHandler, Router } from 'express';
import { z } from 'zod';
import { COBRO } from '../../config/planes.js';
import { errores } from '../../shared/errores.js';
import { parsear } from '../../shared/http/validacion.js';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { type Guardias, sesionDe } from '../auth/guardias.js';
import { SOLO_ADMIN } from '../auth/permisos.js';
import type { UrlBase } from '../empresas/fotos.js';
import type { ServicioFormasPago, TipoQr } from './formasPago.servicio.js';
import type { ServicioPagosManuales } from './pagos.manual.servicio.js';
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

// Pagos manuales: solo llega el periodo. Los profesionales y el monto los calcula el servidor (cualquier otro campo se ignora)
const esquemaOrdenManual = z.object({ periodo: esquemaOrden.shape.periodo }, { error: 'Envía el periodo del plan ("mensual" o "anual")' });

const esquemaQr = z.object({ tipo: z.enum(['nequi', 'breb'], { error: 'El código QR debe ser "nequi" o "breb"' }) });

const esquemaEstado = z.object({ id: z.string().trim().min(1).max(100).optional() });

const esquemaConfirmacion = z.object({ idTransaccion: z.string().trim().min(1).max(100).optional() }).optional();

// Pagos de la suscripción. Los administradores pagan también con la suscripción vencida (por eso no llevan la
// guardia de suscripción vigente, igual que Mi negocio y /suscripcion).
export type PagosManuales = { ordenes: ServicioPagosManuales; formas: ServicioFormasPago; urlBase: UrlBase };

export const crearRutasPagos = (
  pagos: ServicioPagos,
  guardias: Guardias,
  limitadores: Limitadores,
  proveedor?: ProveedorPago & { rutas?: () => Router },
  manuales?: PagosManuales,
) => {
  const rutas = Router();
  const soloAdmin = [guardias.requerirSesion, guardias.requerirAdmin(SOLO_ADMIN)];
  // El tope de órdenes es de los pagos manuales y va después de las guardias: así no lo gasta quien no tiene sesión
  // ni cambia el comportamiento de las pasarelas
  const limitarOrdenesManuales: RequestHandler = (req, res, next) =>
    proveedor?.nombre === 'manual' ? limitadores.ordenesPago(req, res, next) : next();

  // Webhook de la pasarela (público: la firma es la autenticación). Mientras no haya proveedor con webhook activo, 404.
  rutas.post('/webhook', async (req, res) => {
    if (!proveedor?.verificarEvento) throw errores.noEncontrado('Ruta no encontrada');
    if (!(await pagos.procesarEvento(req.body))) throw errores.noAutenticado('Firma del evento no válida');
    res.json({ recibido: true });
  });

  // Página de pago de pruebas (solo existe con el proveedor simulado, que no arranca en producción)
  if (proveedor?.rutas) rutas.use('/simulado', proveedor.rutas());

  // Públicos (la app los llama al volver de la pasarela, a veces sin sesión)
  rutas.get('/configuracion', limitadores.estadoPago, (_req, res) => {
    res.json(pagos.configuracion());
  });

  // `id` es el id de la transacción que devuelve la pasarela al redirigir. Consulta y confirma con el proveedor.
  rutas.get('/ordenes/:referencia/estado', limitadores.estadoPago, async (req, res) => {
    const { id } = parsear(esquemaEstado, req.query);
    res.json(await pagos.estadoPublico(String(req.params.referencia), id));
  });

  // Con el proveedor manual no se acepta un monto ni un número de profesionales: solo el periodo
  rutas.post('/ordenes', ...soloAdmin, limitarOrdenesManuales, async (req, res) => {
    if (proveedor?.nombre === 'manual' && manuales) {
      const { periodo } = parsear(esquemaOrdenManual, req.body);
      res.status(201).json(await manuales.ordenes.crearOrden(sesionDe(res).empresaId, { periodo }, manuales.urlBase(req)));
      return;
    }
    const datos = parsear(esquemaOrden, req.body);
    res.status(201).json(await pagos.crearOrden(sesionDe(res).empresaId, datos));
  });

  // Las órdenes del propio negocio (la sesión decide el negocio; nunca llega en la URL)
  rutas.get('/ordenes', limitadores.formasPago, ...soloAdmin, async (_req, res) => {
    if (!manuales) throw errores.noEncontrado('Ruta no encontrada');
    res.json(await manuales.ordenes.listarDelNegocio(sesionDe(res).empresaId));
  });

  rutas.get('/ordenes/:referencia', ...soloAdmin, async (req, res) => {
    const { empresaId } = sesionDe(res);
    const referencia = String(req.params.referencia);
    const manual = manuales ? await manuales.ordenes.consultar(empresaId, referencia, manuales.urlBase(req)) : undefined;
    res.json(manual ?? (await pagos.consultar(empresaId, referencia)));
  });

  // Formas de pago manuales activas: solo para administradores de negocio con sesión (nunca públicas)
  rutas.get('/formas-pago', limitadores.formasPago, ...soloAdmin, async (req, res) => {
    if (!manuales) throw errores.noEncontrado('Ruta no encontrada');
    res.json(await manuales.formas.activasObligatorias(manuales.urlBase(req)));
  });

  rutas.get('/formas-pago/qr/:tipo', limitadores.formasPago, ...soloAdmin, async (req, res) => {
    if (!manuales) throw errores.noEncontrado('Ruta no encontrada');
    const { tipo } = parsear(esquemaQr, req.params);
    const { imagen, tipo: mime } = await manuales.formas.imagenQr(tipo as TipoQr, true);
    res.set({ 'Content-Type': mime, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' }).send(imagen);
  });

  // Al volver del pago: el backend pregunta el estado a la pasarela (nunca confía en lo que diga la app)
  rutas.post('/ordenes/:referencia/confirmar', ...soloAdmin, async (req, res) => {
    const datos = parsear(esquemaConfirmacion, req.body);
    res.json(await pagos.confirmar(sesionDe(res).empresaId, String(req.params.referencia), datos?.idTransaccion));
  });

  return rutas;
};
