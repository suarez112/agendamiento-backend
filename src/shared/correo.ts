import { registro } from './registro.js';

// Envío de correos detrás de una interfaz simple: el resto del código no sabe
// qué proveedor se usa. crearEnviadorCorreo elige la implementación según el entorno.
export type Correo = { para: string; asunto: string; texto: string };

export type EnviadorCorreo = { enviar(correo: Correo): Promise<void> };

// Error de envío cuyo mensaje es seguro para el registro: solo el código HTTP y el tipo de
// error del proveedor, nunca el destinatario, el texto (puede llevar códigos) ni la clave.
export class ErrorEnvioCorreo extends Error {
  override name = 'ErrorEnvioCorreo';
}

// Desarrollo y pruebas: no envía nada, imprime el correo en la consola del backend
export const crearEnviadorConsola = (): EnviadorCorreo => ({
  async enviar({ para, asunto, texto }) {
    console.log(`\n📧 Correo (no enviado, modo desarrollo)\nPara: ${para}\nAsunto: ${asunto}\n\n${texto}\n`);
  },
});

// Producción sin proveedor configurado: no envía ni muestra el contenido (puede
// llevar códigos de acceso), solo deja el aviso en el log.
const crearEnviadorSinConfigurar = (): EnviadorCorreo => ({
  async enviar({ asunto }) {
    registro.error('correo_sin_proveedor', { asunto });
  },
});

const URL_RESEND = 'https://api.resend.com/emails';
const TIEMPO_MAXIMO_MS = 10_000;
// Los tipos de error de Resend son códigos fijos (validation_error, rate_limit_exceeded…); otro texto no se copia
const TIPO_DE_ERROR = /^[a-z_]{1,60}$/;

const tipoDeErrorResend = async (respuesta: Response): Promise<string | null> => {
  try {
    const cuerpo = (await respuesta.json()) as { name?: unknown } | null;
    return typeof cuerpo?.name === 'string' && TIPO_DE_ERROR.test(cuerpo.name) ? cuerpo.name : null;
  } catch {
    return null;
  }
};

export type OpcionesResend = {
  apiKey: string;
  remitente: string; // ej. "Agendality <no-reply@agendality.com>"
  responderA?: string;
  fetch?: typeof fetch;
  tiempoMs?: number;
};

// Resend (https://resend.com/docs/api-reference/emails/send-email): un POST por correo, con tiempo máximo.
// Cualquier fallo lanza ErrorEnvioCorreo; quien llama decide qué registrar.
export const crearEnviadorResend = ({
  apiKey,
  remitente,
  responderA,
  fetch: enviarSolicitud = globalThis.fetch,
  tiempoMs = TIEMPO_MAXIMO_MS,
}: OpcionesResend): EnviadorCorreo => ({
  async enviar({ para, asunto, texto }) {
    let respuesta: Response;
    try {
      respuesta = await enviarSolicitud(URL_RESEND, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: remitente,
          to: [para],
          subject: asunto,
          text: texto,
          ...(responderA ? { reply_to: responderA } : {}),
        }),
        signal: AbortSignal.timeout(tiempoMs),
      });
    } catch (error) {
      // Solo el tipo (TimeoutError, TypeError…): el mensaje de un error de red podría traer otros datos
      const tipo = error instanceof Error && TIPO_DE_ERROR.test(error.name.toLowerCase()) ? error.name : 'desconocido';
      throw new ErrorEnvioCorreo(`Resend no respondió (${tipo})`);
    }
    if (!respuesta.ok) {
      const tipo = await tipoDeErrorResend(respuesta);
      throw new ErrorEnvioCorreo(`Resend respondió ${respuesta.status}${tipo ? ` (${tipo})` : ''}`);
    }
    await respuesta.body?.cancel().catch(() => undefined);
  },
});

export type EntornoCorreo = {
  NODE_ENV: string;
  RESEND_API_KEY?: string;
  CORREO_REMITENTE?: string;
  CORREO_RESPONDER_A?: string;
};

// Con RESEND_API_KEY (y su remitente, que exige entorno.ts) se envía por Resend. Sin clave, como siempre:
// en producción solo el aviso en el log y en desarrollo la consola. En las pruebas nunca se envía nada real.
export const crearEnviadorCorreo = (entorno: EntornoCorreo, opciones: { fetch?: typeof fetch } = {}): EnviadorCorreo => {
  if (entorno.NODE_ENV !== 'test' && entorno.RESEND_API_KEY && entorno.CORREO_REMITENTE) {
    return crearEnviadorResend({
      apiKey: entorno.RESEND_API_KEY,
      remitente: entorno.CORREO_REMITENTE,
      responderA: entorno.CORREO_RESPONDER_A,
      fetch: opciones.fetch,
    });
  }
  return entorno.NODE_ENV === 'production' ? crearEnviadorSinConfigurar() : crearEnviadorConsola();
};

// Mensaje de un fallo de envío apto para el registro: el de ErrorEnvioCorreo, o solo el tipo de cualquier otro error
export const motivoFalloCorreo = (error: unknown): string =>
  error instanceof ErrorEnvioCorreo ? error.message : error instanceof Error ? error.name : 'desconocido';
