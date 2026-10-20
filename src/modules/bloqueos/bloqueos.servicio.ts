import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import type { Sesion } from '../auth/auth.servicio.js';
import { listarHorarios, NOMBRES_DIAS } from '../empresas/horario.js';
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

const PLURAL_DIAS = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];

// Día de la semana (0 = domingo) de una fecha AAAA-MM-DD, sin depender de la zona horaria
const diaDeFecha = (fecha: string) => new Date(`${fecha}T12:00:00Z`).getUTCDay();

// Un bloqueo solo puede caer en un día abierto y dentro del horario de ese día.
// Un bloqueo de día completo cubre todo el horario, así que solo exige que abra.
const validarContraHorario = async (pool: pg.Pool, empresaId: string, datos: DatosBloqueo) => {
  const dia = datos.diaSemana ?? diaDeFecha(datos.fecha!);
  const horario = (await listarHorarios(pool, [empresaId])).find((h) => h.dia_semana === dia);
  const cuando = datos.fecha ? `el ${NOMBRES_DIAS[dia]} ${datos.fecha}` : `los ${PLURAL_DIAS[dia]}`;
  if (!horario) {
    throw errores.solicitudInvalida(`El negocio está cerrado ${cuando}. Elige un día en que esté abierto.`);
  }
  const todoElDia = datos.horaInicio === DIA_COMPLETO.horaInicio && datos.horaFin === DIA_COMPLETO.horaFin;
  // "HH:MM" se compara bien como texto
  if (!todoElDia && (datos.horaInicio < horario.hora_apertura || datos.horaFin > horario.hora_cierre)) {
    throw errores.solicitudInvalida(
      `El bloqueo debe estar dentro del horario del negocio: ${cuando} abre de ${horario.hora_apertura} a ${horario.hora_cierre}.`,
    );
  }
};

// Solo el administrador ve, crea y borra bloqueos (la ruta lo exige).
export const crearServicioBloqueos = ({ pool }: { pool: pg.Pool }) => ({
  async listar(sesion: Sesion, barberoId: string | undefined) {
    return (await repositorio.listarBloqueos(pool, sesion.empresaId, barberoId ?? null)).map(armarBloqueo);
  },

  async crear(sesion: Sesion, datos: DatosBloqueo) {
    await validarContraHorario(pool, sesion.empresaId, datos);
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
