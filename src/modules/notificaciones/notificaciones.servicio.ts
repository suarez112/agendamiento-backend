import type pg from 'pg';
import { registro } from '../../shared/registro.js';
import type { EnviadorPush, MensajePush } from '../../shared/push.js';
import * as repositorio from './notificaciones.repositorio.js';
import type { DatosAviso, Titular } from './notificaciones.repositorio.js';

// Avisos que dispara el módulo de citas. Ninguno lanza error: si el envío falla, solo
// queda en el log, y la reserva o la cancelación ya terminaron bien.
export type Avisos = {
  avisarCitaNueva(citaId: string): Promise<void>;
  avisarCancelacionPorNegocio(citaId: string): Promise<void>;
  avisarCancelacionPorCliente(citaId: string): Promise<void>;
};

export const crearServicioNotificaciones = ({ pool, push }: { pool: pg.Pool; push: EnviadorPush }) => {
  // Envía y borra los tokens que Expo ya no reconoce
  const despachar = async (mensajes: MensajePush[]) => {
    if (!mensajes.length) return;
    const resultados = await push.enviar(mensajes);
    const invalidos = [...new Set(resultados.filter((r) => r.tokenInvalido).map((r) => r.token))];
    if (invalidos.length) await repositorio.borrarTokens(pool, invalidos);
  };

  // El mismo aviso a varios celulares (sin repetir ninguno)
  const aTokens = (tokens: string[], contenido: Omit<MensajePush, 'to'>): MensajePush[] =>
    [...new Set(tokens)].map((to) => ({ to, ...contenido }));

  const seguro = async (evento: string, trabajo: () => Promise<void>) => {
    try {
      await trabajo();
    } catch (error) {
      registro.error('push_fallo', { evento, mensaje: (error as Error).message });
    }
  };

  const avisarAlNegocio = (evento: string, citaId: string, armar: (c: DatosAviso) => Omit<MensajePush, 'to'>) =>
    seguro(evento, async () => {
      const cita = await repositorio.datosAviso(pool, citaId);
      if (!cita) return;
      const tokens = await repositorio.tokensDelNegocio(pool, { empresaId: cita.empresa_id, barberoId: cita.barbero_id });
      await despachar(aTokens(tokens, armar(cita)));
    });

  const avisos: Avisos = {
    // Cita nueva (de un invitado o de un cliente con cuenta): al profesional y a los administradores
    avisarCitaNueva: (citaId) =>
      avisarAlNegocio('cita_nueva', citaId, (c) => ({
        title: 'Nueva cita',
        body: `${c.cliente} reservó ${c.servicio} para el ${c.fecha} a las ${c.hora}.`,
        data: { tipo: 'cita_nueva', citaId: c.id },
      })),

    // El cliente canceló: al profesional y a los administradores
    avisarCancelacionPorCliente: (citaId) =>
      avisarAlNegocio('cancelacion_cliente', citaId, (c) => ({
        title: 'Cita cancelada por el cliente',
        body: `${c.cliente} canceló ${c.servicio} del ${c.fecha} a las ${c.hora}.`,
        data: { tipo: 'cita_cancelada_por_cliente', citaId: c.id },
      })),

    // El negocio canceló: al cliente, solo si reservó con su cuenta
    avisarCancelacionPorNegocio: (citaId) =>
      seguro('cancelacion_negocio', async () => {
        const cita = await repositorio.datosAviso(pool, citaId);
        if (!cita?.usuario_id) return;
        const filas = await repositorio.tokensDeUsuarios(pool, [cita.usuario_id]);
        await despachar(
          aTokens(
            filas.map((f) => f.token),
            {
              title: 'Cita cancelada',
              body: `${cita.negocio} canceló tu cita de ${cita.servicio} del ${cita.fecha} a las ${cita.hora}.`,
              data: { tipo: 'cita_cancelada', citaId: cita.id },
            },
          ),
        );
      }),
  };

  return {
    ...avisos,

    registrarDispositivo: (titular: Titular, token: string, plataforma: string | null) =>
      repositorio.guardarDispositivo(pool, { ...titular, token, plataforma }),

    borrarDispositivo: (titular: Titular, token: string) => repositorio.borrarDispositivo(pool, { ...titular, token }),

    // Recordatorio de las citas que empiezan en ~24 h. Lo llama la tarea programada cada 15 minutos.
    // Devuelve cuántas citas recordó.
    async enviarRecordatorios() {
      const citas = await repositorio.reclamarRecordatorios(pool);
      if (!citas.length) return 0;
      await seguro('recordatorios', async () => {
        const usuarios = [...new Set(citas.map((c) => c.usuario_id as string))];
        const filas = await repositorio.tokensDeUsuarios(pool, usuarios);
        const mensajes = citas.flatMap((c) =>
          aTokens(
            filas.filter((f) => f.usuario_id === c.usuario_id).map((f) => f.token),
            {
              title: 'Recordatorio de tu cita',
              body: `Tienes ${c.servicio} en ${c.negocio} el ${c.fecha} a las ${c.hora}.`,
              data: { tipo: 'recordatorio', citaId: c.id },
            },
          ),
        );
        await despachar(mensajes);
      });
      return citas.length;
    },
  };
};

export type ServicioNotificaciones = ReturnType<typeof crearServicioNotificaciones>;
