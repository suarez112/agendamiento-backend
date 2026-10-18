import cors from 'cors';
import type { Entorno } from '../../config/entorno.js';

const ORIGEN_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// La app nativa no envía el encabezado Origin, así que CORS solo afecta a la
// versión web. Se permiten los orígenes de CORS_ORIGINS y, fuera de producción,
// localhost (servidor web de Expo).
export const crearCors = (entorno: Pick<Entorno, 'CORS_ORIGINS' | 'NODE_ENV'>) =>
  cors({
    origin: (origen, responder) => {
      const permitido =
        !origen ||
        entorno.CORS_ORIGINS.includes(origen) ||
        (entorno.NODE_ENV !== 'production' && ORIGEN_LOCAL.test(origen));
      responder(null, permitido);
    },
    methods: ['GET', 'POST', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });
