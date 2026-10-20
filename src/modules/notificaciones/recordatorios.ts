import { registro } from '../../shared/registro.js';
import type { ServicioNotificaciones } from './notificaciones.servicio.js';

const CADA_15_MINUTOS = 15 * 60_000;

// Tarea programada: cada 15 minutos recuerda las citas que empiezan en ~24 h. Corre en el
// proceso del servidor (la arranca server.ts, no crearApp). Cada cita se marca al
// reclamarla, así que no se recuerda dos veces aunque haya varias instancias. Un fallo
// solo queda en el log y la tarea sigue con la siguiente vuelta. Devuelve la función que la detiene.
export const iniciarRecordatorios = (
  notificaciones: Pick<ServicioNotificaciones, 'enviarRecordatorios'>,
  cadaMs = CADA_15_MINUTOS,
) => {
  let enCurso = false;

  const ejecutar = async () => {
    if (enCurso) return; // la vuelta anterior no terminó
    enCurso = true;
    try {
      const citas = await notificaciones.enviarRecordatorios();
      if (citas > 0) registro.info('recordatorios_enviados', { citas });
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
