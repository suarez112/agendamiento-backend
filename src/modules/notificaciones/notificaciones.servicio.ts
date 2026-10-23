import { aIsoEnZona } from '../../shared/zonaHoraria.js';
import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import { registro } from '../../shared/registro.js';
import type { EnviadorPush, MensajePush } from '../../shared/push.js';
import * as repositorio from './notificaciones.repositorio.js';
import type { ContenidoNotificacion, DatosAviso, Titular } from './notificaciones.repositorio.js';

// Avisos que dispara el módulo de citas. Ninguno lanza error: si el envío falla, solo
// queda en el log, y la reserva o la cancelación ya terminaron bien.
export type Avisos = {
  avisarCitaNueva(citaId: string): Promise<void>;
  avisarCancelacionPorNegocio(citaId: string): Promise<void>;
  avisarCancelacionPorCliente(citaId: string): Promise<void>;
  // anterior: fecha (DD/MM/AAAA) y hora (12 h) que tenía la cita antes del cambio
  avisarReprogramacion(citaId: string, anterior: { fecha: string; hora: string }): Promise<void>;
};

const armarNotificacion = (n: repositorio.FilaNotificacion) => ({
  id: n.id,
  tipo: n.tipo,
  titulo: n.titulo,
  texto: n.texto,
  citaId: n.cita_id,
  leida: n.leida,
  leidaEn: aIsoEnZona(n.leida_en, n.zona_horaria),
  creadaEn: aIsoEnZona(n.creada_en, n.zona_horaria),
  zonaHoraria: n.zona_horaria,
});

export const crearServicioNotificaciones = ({ pool, push }: { pool: pg.Pool; push: EnviadorPush }) => {
  // Envía y borra los tokens que Expo ya no reconoce
  const despachar = async (mensajes: MensajePush[]) => {
    if (!mensajes.length) return;
    const resultados = await push.enviar(mensajes);
    const invalidos = [...new Set(resultados.filter((r) => r.tokenInvalido).map((r) => r.token))];
    if (invalidos.length) await repositorio.borrarTokens(pool, invalidos);
  };

  const seguro = async (evento: string, trabajo: () => Promise<void>) => {
    try {
      await trabajo();
    } catch (error) {
      registro.error('push_fallo', { evento, mensaje: (error as Error).message });
    }
  };

  // Cada evento crea la notificación interna de cada destinatario y, si tiene celular
  // registrado, envía también la push. Los dos pasos son independientes y ninguno lanza
  // error: si uno falla, solo queda en el log y la reserva o la cancelación no se afectan.
  const notificar = async (evento: string, titulares: Titular[], c: ContenidoNotificacion) => {
    if (!titulares.length) return;
    await seguro(`${evento}:interna`, () => repositorio.crearNotificaciones(pool, titulares, c));
    await seguro(`${evento}:push`, async () => {
      const tokens = [...new Set(await repositorio.tokensDe(pool, titulares))];
      await despachar(
        tokens.map((to) => ({ to, title: c.titulo, body: c.texto, data: { tipo: c.tipo, citaId: c.citaId } })),
      );
    });
  };

  const avisarAlNegocio = (evento: string, citaId: string, armar: (c: DatosAviso) => ContenidoNotificacion) =>
    seguro(evento, async () => {
      const cita = await repositorio.datosAviso(pool, citaId);
      if (!cita) return;
      const titulares = await repositorio.destinatariosDelNegocio(pool, { empresaId: cita.empresa_id, barberoId: cita.barbero_id });
      await notificar(evento, titulares, armar(cita));
    });

  const avisos: Avisos = {
    // Cita nueva (de un invitado o de un cliente con cuenta): al profesional y a los administradores
    avisarCitaNueva: (citaId) =>
      avisarAlNegocio('cita_nueva', citaId, (c) => ({
        tipo: 'cita_nueva',
        titulo: 'Nueva cita',
        texto: `${c.cliente} reservó ${c.servicio} para el ${c.fecha} a las ${c.hora}.`,
        citaId: c.id,
      })),

    // El cliente canceló: al profesional y a los administradores
    avisarCancelacionPorCliente: (citaId) =>
      avisarAlNegocio('cita_cancelada_por_cliente', citaId, (c) => ({
        tipo: 'cita_cancelada_por_cliente',
        titulo: 'Cita cancelada por el cliente',
        texto: `${c.cliente} canceló ${c.servicio} del ${c.fecha} a las ${c.hora}.`,
        citaId: c.id,
      })),

    // El cliente cambió la fecha u hora de su cita: al profesional y a los administradores
    avisarReprogramacion: (citaId, anterior) =>
      avisarAlNegocio('cita_reprogramada', citaId, (c) => ({
        tipo: 'cita_reprogramada',
        titulo: 'Cita reprogramada por el cliente',
        texto: `${c.cliente} movió ${c.servicio} del ${anterior.fecha} a las ${anterior.hora} al ${c.fecha} a las ${c.hora}.`,
        citaId: c.id,
      })),

    // El negocio canceló: al cliente, solo si reservó con su cuenta
    avisarCancelacionPorNegocio: (citaId) =>
      seguro('cita_cancelada', async () => {
        const cita = await repositorio.datosAviso(pool, citaId);
        if (!cita?.usuario_id) return;
        await notificar('cita_cancelada', [{ usuarioId: cita.usuario_id, barberoId: null }], {
          tipo: 'cita_cancelada',
          titulo: 'Cita cancelada',
          texto: `${cita.negocio} canceló tu cita de ${cita.servicio} del ${cita.fecha} a las ${cita.hora}.`,
          citaId: cita.id,
        });
      }),
  };

  return {
    ...avisos,

    // Centro de notificaciones de la app
    async listar(titular: Titular, p: { soloNoLeidas: boolean; pagina: number; limite: number }) {
      const [filas, cifras] = await Promise.all([
        repositorio.listarNotificaciones(pool, titular, {
          soloNoLeidas: p.soloNoLeidas,
          limite: p.limite,
          desplazamiento: (p.pagina - 1) * p.limite,
        }),
        repositorio.contarNotificaciones(pool, titular),
      ]);
      return {
        total: p.soloNoLeidas ? cifras.no_leidas : cifras.total,
        noLeidas: cifras.no_leidas,
        pagina: p.pagina,
        limite: p.limite,
        datos: filas.map(armarNotificacion),
      };
    },

    async contarNoLeidas(titular: Titular) {
      return { noLeidas: (await repositorio.contarNotificaciones(pool, titular)).no_leidas };
    },

    async marcarLeida(titular: Titular, id: string) {
      const fila = await repositorio.marcarLeida(pool, titular, id);
      if (!fila) throw errores.noEncontrado('Notificación no encontrada');
      return armarNotificacion(fila);
    },

    async marcarTodasLeidas(titular: Titular) {
      return { mensaje: 'Notificaciones marcadas como leídas', marcadas: await repositorio.marcarTodasLeidas(pool, titular) };
    },

    registrarDispositivo: (titular: Titular, token: string, plataforma: string | null) =>
      repositorio.guardarDispositivo(pool, { ...titular, token, plataforma }),

    borrarDispositivo: (titular: Titular, token: string) => repositorio.borrarDispositivo(pool, { ...titular, token }),

    // Recordatorios de citas a los clientes con cuenta (notificación interna y push). Los llama la tarea
    // programada cada 15 minutos. "24h" recuerda las que empiezan en ~24 h y "2h" las que empiezan en ~2 h.
    // Devuelve cuántas citas recordó.
    async enviarRecordatorios(tipo: repositorio.TipoRecordatorio = '24h') {
      const citas = await repositorio.reclamarRecordatorios(pool, tipo);
      if (!citas.length) return 0;
      await Promise.all(
        citas.map((c) =>
          notificar(tipo === '2h' ? 'recordatorio_2h' : 'recordatorio', [{ usuarioId: c.usuario_id, barberoId: null }], {
            tipo: tipo === '2h' ? 'recordatorio_2h' : 'recordatorio',
            titulo: tipo === '2h' ? 'Tu cita es en 2 horas' : 'Recordatorio de tu cita',
            texto: `Tienes ${c.servicio} en ${c.negocio} el ${c.fecha} a las ${c.hora}.`,
            citaId: c.id,
          }),
        ),
      );
      return citas.length;
    },

    // Aviso de la prueba gratuita (día 10 y día 14) a los administradores del negocio, con un resumen de
    // lo logrado y la invitación a activar un plan. No va a quien ya tiene un plan activo y cada aviso
    // se envía una sola vez. Devuelve cuántos avisos envió.
    async enviarAvisosPrueba() {
      const avisos = await repositorio.reclamarAvisosPrueba(pool);
      for (const a of avisos) {
        await seguro(`prueba_dia_${a.dia}`, async () => {
          const administradores = await repositorio.administradoresDe(pool, a.empresa_id);
          const ventas = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(a.ventas));
          const logro = `En tu prueba gratuita has gestionado ${a.citas} cita(s) y vendido ${ventas}.`;
          await notificar(`prueba_dia_${a.dia}`, administradores, {
            tipo: 'prueba_resumen',
            titulo: a.dia === 10 ? 'Vas muy bien en tu prueba gratuita' : 'Tu prueba gratuita termina pronto',
            texto: `${logro} Te ${a.dias_restantes === 1 ? 'queda 1 día' : `quedan ${a.dias_restantes} días`}: activa un plan para seguir usando AgendaYa sin interrupciones.`,
            citaId: null,
          });
        });
      }
      return avisos.length;
    },
  };
};

export type ServicioNotificaciones = ReturnType<typeof crearServicioNotificaciones>;
