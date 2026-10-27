import { isIP } from 'node:net';
import type { Request } from 'express';

// IP de la conexión que hace la petición. Es la única fuente de la IP para los límites de solicitudes y
// para la prueba de las autorizaciones. Sale SOLO de la petición HTTP, nunca del cuerpo.
//
// - Sin proxy de confianza (TRUST_PROXY=0, el valor por defecto) es la IP de la conexión directa: los
//   encabezados X-Forwarded-For y CF-Connecting-IP se ignoran, porque cualquiera puede escribirlos.
// - Con TRUST_PROXY > 0, Express resuelve X-Forwarded-For contando esos proxies.
// - CF-Connecting-IP solo se acepta si además se declaró DETRAS_DE_CLOUDFLARE=true. Detrás de otro proxy,
//   cualquiera podría escribir ese encabezado y falsear su IP.
export const AJUSTE_CLOUDFLARE = 'detras de cloudflare';

export const ipDe = (req: Request): string | null => {
  const hayProxy = Number(req.app.get('trust proxy')) > 0;
  const cf = hayProxy && req.app.get(AJUSTE_CLOUDFLARE) === true ? req.get('cf-connecting-ip')?.trim() : undefined;
  const bruta = cf && isIP(cf) ? cf : hayProxy ? req.ip : req.socket.remoteAddress;
  const ip = bruta ? bruta.replace(/^::ffff:/i, '') : null;
  return ip && isIP(ip) ? ip : null;
};
