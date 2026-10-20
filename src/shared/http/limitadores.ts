import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';

// Correo del cuerpo, normalizado, para limitar por cuenta y no solo por IP
const correoDelCuerpo = (req: Request) => {
  const correo = (req.body as { correo?: unknown } | undefined)?.correo;
  return `correo:${typeof correo === 'string' ? correo.trim().toLowerCase().slice(0, 254) : ''}`;
};

// Máximo de solicitudes por IP en cada ventana de tiempo. El almacenamiento es
// en memoria: con varias instancias del servidor hay que usar un store
// compartido (ej. Redis) para que el límite sea global.
export type ConfigLimites = {
  ventanaMs: number;
  general: number;
  login: number; // solo cuentan los intentos fallidos
  codigoNegocio: number;
  reservas: number;
  registro: number; // empresas y cuentas nuevas
  recuperacion: number; // recuperar contraseña: solicitudes y restablecer, por IP
  recuperacionPorCorreo: number; // solicitudes de código para un mismo correo
};

export const LIMITES_POR_DEFECTO: ConfigLimites = {
  ventanaMs: 15 * 60_000,
  general: 300,
  login: 10,
  codigoNegocio: 60,
  reservas: 20,
  registro: 10,
  recuperacion: 10,
  recuperacionPorCorreo: 3,
};

const limitar = (
  ventanaMs: number,
  limite: number,
  mensaje: string,
  soloFallidos = false,
  clave?: (req: Request) => string,
) =>
  rateLimit({
    windowMs: ventanaMs,
    ...(clave && { keyGenerator: clave }),
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
  registro: limitar(c.ventanaMs, c.registro, 'Demasiados registros seguidos. Intenta de nuevo en unos minutos.'),
  recuperacion: limitar(
    c.ventanaMs,
    c.recuperacion,
    'Demasiados intentos para recuperar la contraseña. Intenta de nuevo en unos minutos.',
  ),
  recuperacionPorCorreo: limitar(
    c.ventanaMs,
    c.recuperacionPorCorreo,
    'Ya pediste varios códigos para este correo. Espera unos minutos antes de pedir otro.',
    false,
    correoDelCuerpo,
  ),
});

export type Limitadores = ReturnType<typeof crearLimitadores>;
