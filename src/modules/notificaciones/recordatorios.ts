import { registro } from '../../shared/registro.js';
import type { ServicioNotificaciones } from './notificaciones.servicio.js';

const CADA_15_MINUTOS = 15 * 60_000;

// Tarea programada: cada 15 minutos recuerda las citas que empiezan en ~24 h y en ~2 h, y envía los
// avisos de la prueba gratuita (día 10 y día 14). Corre en el proceso del servidor (la arranca server.ts,
// no crearApp). Cada cita y cada aviso se marcan al reclamarlos, así que no se envían dos veces aunque
// haya varias instancias. Un fallo solo queda en el log y la tarea sigue con la siguiente vuelta.
// Devuelve la función que la detiene.
export const iniciarRecordatorios = (
  notificaciones: Pick<ServicioNotificaciones, 'enviarRecordatorios' | 'enviarAvisosPrueba'>,
  cadaMs = CADA_15_MINUTOS,
) => {
  let enCurso = false;

  const ejecutar = async () => {
    if (enCurso) return; // la vuelta anterior no terminó
    enCurso = true;
    try {
      const dias = await notificaciones.enviarRecordatorios('24h');
      const horas = await notificaciones.enviarRecordatorios('2h');
      const pruebas = await notificaciones.enviarAvisosPrueba();
      if (dias + horas + pruebas > 0) registro.info('recordatorios_enviados', { citas24h: dias, citas2h: horas, avisosPrueba: pruebas });
    } catch (error) {
      registro.error('recordatorios_fallo', { mensaje: (error as Error).message });
    } finally {
      enCurso = false;
    }
  };

  const temporizador = setInterval(() => void ejecutar(), cadaMs);
  temporizador.unref();
  void ejecutar();
  return () => clearInterval(temporizador);
};
