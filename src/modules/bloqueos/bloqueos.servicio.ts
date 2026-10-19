import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import type { Sesion } from '../auth/auth.servicio.js';
import * as repositorio from './bloqueos.repositorio.js';
import type { FilaBloqueo } from './bloqueos.repositorio.js';

// Ya validado por la ruta: exactamente uno de diaSemana o fecha viene lleno.
// Un día completo llega como 00:00 a 24:00.
export type DatosBloqueo = {
  barberoId: string;
  diaSemana: number | null;
  fecha: string | null;
  horaInicio: string;
  horaFin: string;
  motivo: string | null;
};

export const DIA_COMPLETO = { horaInicio: '00:00', horaFin: '24:00' };

export const esDiaCompleto = (b: { hora_inicio: string; hora_fin: string }) =>
  b.hora_inicio === DIA_COMPLETO.horaInicio && b.hora_fin === DIA_COMPLETO.horaFin;

const armarBloqueo = (b: FilaBloqueo) => ({
  id: b.id,
  barberoId: b.barbero_id,
  barberoNombre: b.barbero_nombre,
  tipo: b.dia_semana !== null ? 'semanal' : 'fecha',
  diaSemana: b.dia_semana,
  fecha: b.fecha,
  todoElDia: esDiaCompleto(b),
  horaInicio: b.hora_inicio,
  horaFin: b.hora_fin,
  motivo: b.motivo,
});

// Solo el administrador ve, crea y borra bloqueos (la ruta lo exige).
export const crearServicioBloqueos = ({ pool }: { pool: pg.Pool }) => ({
  async listar(sesion: Sesion, barberoId: string | undefined) {
    return (await repositorio.listarBloqueos(pool, sesion.empresaId, barberoId ?? null)).map(armarBloqueo);
  },

  async crear(sesion: Sesion, datos: DatosBloqueo) {
    const bloqueo = await repositorio.crearBloqueo(pool, { ...datos, empresaId: sesion.empresaId });
    if (!bloqueo) throw errores.noEncontrado('Profesional no encontrado');
    return armarBloqueo(bloqueo);
  },

  async borrar(sesion: Sesion, id: string) {
    if (!(await repositorio.borrarBloqueo(pool, id, sesion.empresaId))) {
      throw errores.noEncontrado('Bloqueo no encontrado');
    }
    return { mensaje: 'Bloqueo eliminado' };
  },
});

export type ServicioBloqueos = ReturnType<typeof crearServicioBloqueos>;
