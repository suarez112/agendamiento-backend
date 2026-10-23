import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ErrorApp, errores } from '../errores.js';
import { registro } from '../registro.js';

export const rutaNoEncontrada: RequestHandler = () => {
  throw errores.noEncontrado('Ruta no encontrada');
};

// Errores que lanza express.json() al leer el cuerpo
const ERRORES_DEL_CUERPO: Record<string, [number, string]> = {
  'entity.parse.failed': [400, 'El cuerpo de la solicitud no es un JSON válido'],
  'entity.too.large': [413, 'La solicitud es demasiado grande'],
  'encoding.unsupported': [415, 'Codificación no soportada'],
  'charset.unsupported': [415, 'Codificación no soportada'],
};

// Último middleware: toda respuesta de error sale con el formato { error } y sin
// detalles internos (pila, SQL, rutas de archivos).
export const manejadorErrores: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ErrorApp) {
    res.status(error.estado).json({ error: error.message, ...error.extra });
    return;
  }

  const delCuerpo = ERRORES_DEL_CUERPO[(error as { type?: string })?.type ?? ''];
  if (delCuerpo) {
    res.status(delCuerpo[0]).json({ error: delCuerpo[1] });
    return;
  }

  registro.error('error_no_controlado', {
    metodo: req.method,
    ruta: req.path,
    mensaje: (error as Error)?.message,
    pila: (error as Error)?.stack,
  });
  res.status(500).json({ error: 'Error interno del servidor' });
};
