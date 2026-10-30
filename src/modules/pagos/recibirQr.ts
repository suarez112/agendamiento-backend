import type { RequestHandler } from 'express';
import multer from 'multer';
import { ErrorApp, errores } from '../../shared/errores.js';
import { MAX_BYTES_QR } from './formasPago.servicio.js';

// Lee la imagen del código QR (campo "qr", multipart/form-data) en memoria. El tipo real se comprueba por el
// contenido en el servicio: aquí solo se limita el tamaño (1 MB) y la forma de la solicitud.
const MENSAJE_CAMPO = 'Envía la imagen en el campo "qr" (multipart/form-data)';

const lector = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES_QR, files: 1, fields: 0, parts: 1 },
}).single('qr');

export const recibirQr: RequestHandler = (req, res, next) => {
  lector(req, res, (error?: unknown) => {
    if (error instanceof multer.MulterError) {
      next(error.code === 'LIMIT_FILE_SIZE' ? errores.demasiadoGrande('El código QR no puede pesar más de 1 MB') : errores.solicitudInvalida(MENSAJE_CAMPO));
      return;
    }
    if (error) {
      next(error instanceof ErrorApp ? error : errores.solicitudInvalida(MENSAJE_CAMPO));
      return;
    }
    if (!req.file) {
      next(errores.solicitudInvalida(MENSAJE_CAMPO));
      return;
    }
    next();
  });
};
