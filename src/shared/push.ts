import { registro } from './registro.js';

// Envío de notificaciones push detrás de una interfaz simple, igual que el correo:
// el resto del código no sabe qué servicio se usa. Hoy es Expo Push
// (https://docs.expo.dev/push-notifications/sending-notifications/).
export type MensajePush = { to: string; title: string; body: string; data?: Record<string, unknown> };

// tokenInvalido = Expo dice que el celular ya no existe (app desinstalada, token vencido):
// quien llama debe borrar ese token.
export type ResultadoPush = { token: string; ok: boolean; tokenInvalido: boolean };

export type EnviadorPush = { enviar(mensajes: MensajePush[]): Promise<ResultadoPush[]> };

const URL_EXPO = 'https://exp.host/--/api/v2/push/send';
const MENSAJES_POR_SOLICITUD = 100; // límite de Expo
const ESPERA_MAXIMA_MS = 10_000;

// Token de Expo: ExponentPushToken[xxxx] (o ExpoPushToken[xxxx])
export const esTokenExpo = (token: string) => /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/.test(token);

type TicketExpo = { status?: string; message?: string; details?: { error?: string } };

export const crearEnviadorExpo = (accessToken?: string): EnviadorPush => ({
  async enviar(mensajes) {
    const resultados: ResultadoPush[] = [];
    for (let i = 0; i < mensajes.length; i += MENSAJES_POR_SOLICITUD) {
      const lote = mensajes.slice(i, i + MENSAJES_POR_SOLICITUD);
      const fallo = lote.map((m) => ({ token: m.to, ok: false, tokenInvalido: false }));
      try {
        const respuesta = await fetch(URL_EXPO, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify(lote.map((m) => ({ ...m, sound: 'default' }))),
          signal: AbortSignal.timeout(ESPERA_MAXIMA_MS),
        });
        if (!respuesta.ok) {
          registro.error('push_expo_respuesta_invalida', { estado: respuesta.status });
          resultados.push(...fallo);
          continue;
        }
        // Expo responde un ticket por mensaje, en el mismo orden
        const { data } = (await respuesta.json()) as { data?: TicketExpo[] };
        lote.forEach((m, n) => {
          const ticket = data?.[n];
          const ok = ticket?.status === 'ok';
          const tokenInvalido = ticket?.details?.error === 'DeviceNotRegistered';
          if (!ok && !tokenInvalido) registro.warn('push_expo_rechazado', { error: ticket?.details?.error ?? ticket?.message });
          resultados.push({ token: m.to, ok, tokenInvalido });
        });
      } catch (error) {
        registro.error('push_expo_fallo', { mensaje: (error as Error).message });
        resultados.push(...fallo);
      }
    }
    return resultados;
  },
});

// Pruebas: no envía nada
export const crearEnviadorPushInactivo = (): EnviadorPush => ({
  async enviar(mensajes) {
    return mensajes.map((m) => ({ token: m.to, ok: true, tokenInvalido: false }));
  },
});

export const crearEnviadorPush = (nodeEnv: string, accessToken?: string): EnviadorPush =>
  nodeEnv === 'test' ? crearEnviadorPushInactivo() : crearEnviadorExpo(accessToken);
