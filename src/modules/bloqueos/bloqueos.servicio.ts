import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import type { Sesion } from '../auth/auth.servicio.js';
import * as repositorio from './bloqueos.repositorio.js';
import type { FilaBloqueo } from './bloqueos.repositorio.js';

export type DatosBloqueo = {
  barberoId?: string;
  diaSemana: number;
  horaInicio: string;
  horaFin: string;
  motivo: string | null | undefined;
};

const armarBloqueo = (b: FilaBloqueo) => ({
  id: b.id,
  barberoId: b.barbero_id,
  barberoNombre: b.barbero_nombre,
  diaSemana: b.dia_semana,
  horaInicio: b.hora_inicio,
  horaFin: b.hora_fin,
  motivo: b.motivo,
});

// Un administrador maneja los bloqueos de todo su equipo; un barbero, solo los suyos
export const crearServicioBloqueos = ({ pool }: { pool: pg.Pool }) => ({
  async listar(sesion: Sesion, barberoId: string | undefined) {
    const filtro = sesion.esAdmin ? (barberoId ?? null) : sesion.barberoId;
    return (await repositorio.listarBloqueos(pool, sesion.empresaId, filtro)).map(armarBloqueo);
  },

  async crear(sesion: Sesion, datos: DatosBloqueo) {
    let barberoId = datos.barberoId;
    if (!sesion.esAdmin) {
      if (barberoId && barberoId !== sesion.barberoId) {
        throw errores.prohibido('Solo puedes bloquear tu propio horario.');
      }
      barberoId = sesion.barberoId ?? undefined;
    }
    if (!barberoId) throw errores.solicitudInvalida('Elige el profesional en "barberoId"');

    const bloqueo = await repositorio.crearBloqueo(pool, {
      ...datos,
      barberoId,
      empresaId: sesion.empresaId,
      motivo: datos.motivo ?? null,
    });
    if (!bloqueo) throw errores.noEncontrado('Profesional no encontrado');
    return armarBloqueo(bloqueo);
  },

  async borrar(sesion: Sesion, id: string) {
    const soloDe = sesion.esAdmin ? null : sesion.barberoId;
    if (!(await repositorio.borrarBloqueo(pool, id, sesion.empresaId, soloDe))) {
      throw errores.noEncontrado('Bloqueo no encontrado');
    }
    return { mensaje: 'Bloqueo eliminado' };
  },
});

export type ServicioBloqueos = ReturnType<typeof crearServicioBloqueos>;
