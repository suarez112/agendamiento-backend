import type { RequestHandler } from 'express';
import { registro } from '../registro.js';

// Diagnóstico temporal de la IP del cliente (activo solo con DIAGNOSTICO_IP=true; apagado por defecto).
// Sirve para saber cuántos proxies hay delante de la API y qué cabecera trae la IP real.
//
// Registra SOLO estos cinco datos: la IP de la conexión directa, X-Forwarded-For, CF-Connecting-IP,
// True-Client-IP y la IP que resolvió Express (req.ip, según TRUST_PROXY). Nunca otras cabeceras, ni
// Authorization, ni cookies, ni la ruta, el cuerpo o el usuario.
export type DatosDiagnosticoIp = {
  conexion: string | null;
  xForwardedFor: string | null;
  cfConnectingIp: string | null;
  trueClientIp: string | null;
  reqIp: string | null;
};

export type EscribirDiagnosticoIp = (datos: DatosDiagnosticoIp) => void;

// Las cabeceras las escribe quien llama: se recortan para que nadie llene el registro con texto largo
const MAX_CARACTERES = 300;
const recortar = (valor: string | undefined): string | null => (valor === undefined ? null : valor.slice(0, MAX_CARACTERES));

export const crearDiagnosticoIp = (escribir: EscribirDiagnosticoIp): RequestHandler => {
  let falloAvisado = false;
  return (req, _res, next) => {
    try {
      escribir({
        conexion: recortar(req.socket.remoteAddress),
        xForwardedFor: recortar(req.get('x-forwarded-for')),
        cfConnectingIp: recortar(req.get('cf-connecting-ip')),
        trueClientIp: recortar(req.get('true-client-ip')),
        reqIp: recortar(req.ip),
      });
    } catch {
      // Un diagnóstico nunca debe romper una solicitud; se avisa una sola vez para que un registro vacío no confunda
      if (!falloAvisado) {
        falloAvisado = true;
        registro.error('diagnostico_ip_fallo', { mensaje: 'No se pudo escribir el diagnóstico de IP' });
      }
    }
    next();
  };
};
