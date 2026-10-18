import { rateLimit } from 'express-rate-limit';

// Máximo de solicitudes por IP en cada ventana de tiempo. El almacenamiento es
// en memoria: con varias instancias del servidor hay que usar un store
// compartido (ej. Redis) para que el límite sea global.
export type ConfigLimites = {
  ventanaMs: number;
  general: number;
  login: number; // solo cuentan los intentos fallidos
  codigoNegocio: number;
  reservas: number;
};

export const LIMITES_POR_DEFECTO: ConfigLimites = {
  ventanaMs: 15 * 60_000,
  general: 300,
  login: 10,
  codigoNegocio: 60,
  reservas: 20,
};

const limitar = (ventanaMs: number, limite: number, mensaje: string, soloFallidos = false) =>
  rateLimit({
    windowMs: ventanaMs,
    limit: limite,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: soloFallidos,
    handler: (_req, res, _next, opciones) => {
      res.status(opciones.statusCode).json({ error: mensaje });
    },
  });

export const crearLimitadores = (c: ConfigLimites) => ({
  general: limitar(c.ventanaMs, c.general, 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.'),
  login: limitar(
    c.ventanaMs,
    c.login,
    'Demasiados intentos de inicio de sesión. Intenta de nuevo en unos minutos.',
    true,
  ),
  codigoNegocio: limitar(c.ventanaMs, c.codigoNegocio, 'Demasiados intentos. Intenta de nuevo en unos minutos.'),
  reservas: limitar(c.ventanaMs, c.reservas, 'Demasiadas reservas seguidas. Intenta de nuevo en unos minutos.'),
});

export type Limitadores = ReturnType<typeof crearLimitadores>;
