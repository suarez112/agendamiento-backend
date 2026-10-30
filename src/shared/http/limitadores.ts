import type { Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { ipDe } from './ip.js';

// Cada limitador tiene su propio contador: un fallo de login en una ruta no gasta los intentos de otra.
// Las IP compartidas (redes móviles, un local con una sola conexión) se cubren con topes más altos por IP;
// el freno a quien adivina contraseñas es el contador por cuenta, guardado en la base de datos
// (modules/auth/intentos.ts).

// Correo del cuerpo, normalizado, para limitar por cuenta y no solo por IP
const correoDelCuerpo = (req: Request) => {
  const correo = (req.body as { correo?: unknown } | undefined)?.correo;
  return `correo:${typeof correo === 'string' ? correo.trim().toLowerCase().slice(0, 254) : ''}`;
};

// IP de la conexión (ver shared/http/ip.ts), agrupando las direcciones IPv6 por su subred
const porIp = (req: Request) => ipKeyGenerator(ipDe(req) ?? req.ip ?? 'desconocida');

// Máximo de solicitudes por IP en cada ventana de tiempo. El almacenamiento de estos contadores es
// en memoria: con varias instancias del servidor hay que usar un store compartido (ej. Redis) para
// que el límite sea global. Los intentos de login por cuenta sí están en la base.
export type ConfigLimites = {
  ventanaMs: number;
  // Ventana larga para los topes por hora (reservas guardadas)
  ventanaLargaMs: number;
  general: number;
  // Inicios de sesión: solo cuentan los intentos fallidos, y cada ruta tiene su propio contador
  loginUnico: number; // POST /login
  loginPersonal: number; // POST /auth/login
  loginCuentas: number; // POST /cuentas/login
  eliminarCuenta: number; // POST /cuentas/eliminar (la contraseña errónea cuenta)
  loginSuperadmin: number; // POST /superadmin/login
  codigoNegocio: number;
  reservas: number; // intentos de reservar por IP
  reservasCreadas: number; // reservas guardadas por IP en ventanaLargaMs (los intentos con error no cuentan)
  registro: number; // empresas y cuentas nuevas (los errores de validación no cuentan)
  recuperacion: number; // recuperar contraseña: solicitudes y restablecer, por IP
  recuperacionPorCorreo: number; // solicitudes de código para un mismo correo
  pqrs: number; // PQRS radicadas por IP
  estadoPago: number; // consultas públicas del resultado de un pago, por IP
  ordenesPago: number; // órdenes de pago manual creadas por IP
  formasPago: number; // lecturas de las formas de pago (y de sus QR) por IP
  revisionPagos: number; // aprobar, rechazar y configurar pagos manuales (superadmin), por IP
  // Contador por cuenta (base de datos)
  fallosPorCuenta: number; // fallos seguidos de una cuenta antes de bloquearla un rato
  fallosSuperadmin: number; // fallos seguidos de una cuenta del superadmin desde la misma IP
  bloqueoCuentaMs: number; // primer bloqueo; cada bloqueo seguido dura el doble (con tope)
};

export const LIMITES_POR_DEFECTO: ConfigLimites = {
  ventanaMs: 15 * 60_000,
  ventanaLargaMs: 60 * 60_000,
  general: 300,
  loginUnico: 30,
  loginPersonal: 30,
  loginCuentas: 30,
  eliminarCuenta: 10,
  loginSuperadmin: 10,
  codigoNegocio: 60,
  reservas: 20,
  reservasCreadas: 15,
  registro: 10,
  recuperacion: 10,
  recuperacionPorCorreo: 3,
  pqrs: 10,
  estadoPago: 30,
  ordenesPago: 10,
  formasPago: 60,
  revisionPagos: 60,
  fallosPorCuenta: 10,
  fallosSuperadmin: 5,
  bloqueoCuentaMs: 15 * 60_000,
};

type Opciones = {
  // Solo cuentan los intentos fallidos (los correctos no gastan el límite)
  soloFallidos?: boolean;
  clave?: (req: Request) => string;
  // No cuenta las solicitudes que no llegan a hacer nada: las rechazadas por la validación (400)
  // o por cualquier otro error
  noContarErrores?: 'validacion' | 'todos';
  ventanaMs?: number;
};

const limitar = (ventanaMs: number, limite: number, mensaje: string, o: Opciones = {}) =>
  rateLimit({
    windowMs: o.ventanaMs ?? ventanaMs,
    keyGenerator: o.clave ?? porIp,
    limit: limite,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: o.soloFallidos ?? false,
    ...(o.noContarErrores && {
      skipFailedRequests: true,
      requestWasSuccessful: (_req: Request, res: Response) =>
        o.noContarErrores === 'validacion' ? res.statusCode !== 400 : res.statusCode < 400,
    }),
    handler: (_req, res, _next, opciones) => {
      res.status(opciones.statusCode).json({ error: mensaje });
    },
  });

const MENSAJE_LOGIN = 'Demasiados intentos de inicio de sesión. Intenta de nuevo en unos minutos.';

export const crearLimitadores = (c: ConfigLimites) => ({
  pqrs: limitar(c.ventanaMs, c.pqrs, 'Enviaste varias PQRS seguidas. Intenta de nuevo en unos minutos.'),
  estadoPago: limitar(c.ventanaMs, c.estadoPago, 'Demasiadas consultas del pago. Intenta de nuevo en unos minutos.'),
  ordenesPago: limitar(c.ventanaMs, c.ordenesPago, 'Creaste varias órdenes de pago seguidas. Intenta de nuevo en unos minutos.'),
  formasPago: limitar(c.ventanaMs, c.formasPago, 'Demasiadas consultas de las formas de pago. Intenta de nuevo en unos minutos.'),
  revisionPagos: limitar(c.ventanaMs, c.revisionPagos, 'Demasiadas operaciones sobre los pagos. Intenta de nuevo en unos minutos.'),
  general: limitar(c.ventanaMs, c.general, 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.'),
  loginUnico: limitar(c.ventanaMs, c.loginUnico, MENSAJE_LOGIN, { soloFallidos: true }),
  loginPersonal: limitar(c.ventanaMs, c.loginPersonal, MENSAJE_LOGIN, { soloFallidos: true }),
  loginCuentas: limitar(c.ventanaMs, c.loginCuentas, MENSAJE_LOGIN, { soloFallidos: true }),
  eliminarCuenta: limitar(c.ventanaMs, c.eliminarCuenta, MENSAJE_LOGIN, { soloFallidos: true }),
  loginSuperadmin: limitar(c.ventanaMs, c.loginSuperadmin, MENSAJE_LOGIN, { soloFallidos: true }),
  codigoNegocio: limitar(c.ventanaMs, c.codigoNegocio, 'Demasiados intentos. Intenta de nuevo en unos minutos.'),
  reservas: limitar(c.ventanaMs, c.reservas, 'Demasiadas reservas seguidas. Intenta de nuevo en unos minutos.'),
  // Tope por conexión de reservas realmente guardadas, en una ventana más larga: frena a quien llena la agenda
  reservasCreadas: limitar(
    c.ventanaLargaMs,
    c.reservasCreadas,
    'Hiciste muchas reservas desde esta conexión. Intenta de nuevo más tarde.',
    { noContarErrores: 'todos' },
  ),
  registro: limitar(c.ventanaMs, c.registro, 'Demasiados registros seguidos. Intenta de nuevo en unos minutos.', {
    noContarErrores: 'validacion',
  }),
  recuperacion: limitar(
    c.ventanaMs,
    c.recuperacion,
    'Demasiados intentos para recuperar la contraseña. Intenta de nuevo en unos minutos.',
  ),
  recuperacionPorCorreo: limitar(
    c.ventanaMs,
    c.recuperacionPorCorreo,
    'Ya pediste varios códigos para este correo. Espera unos minutos antes de pedir otro.',
    { clave: correoDelCuerpo },
  ),
});

export type Limitadores = ReturnType<typeof crearLimitadores>;
