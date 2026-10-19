import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CODIGO_PG, enTransaccion, esErrorPg } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import type { Sesion } from '../auth/auth.servicio.js';
import type { DatosNuevaCita } from './citas.esquemas.js';
import * as repositorio from './citas.repositorio.js';
import { DIAS_RESERVA } from './citas.repositorio.js';
import { esDiaCompleto } from '../bloqueos/bloqueos.servicio.js';
import { hora12AMinutos, hora24AMinutos, minutosAHHMM } from './horas.js';

const HORA_OCUPADA = 'Esa hora ya está ocupada. Por favor elige otra.';

export const crearServicioCitas = ({ pool }: { pool: pg.Pool }) => ({
  async crear(datos: DatosNuevaCita) {
    const { empresaId, barberoId, servicioId, fecha, hora, nombre, telefono, indicativo } = datos;

    // 1. El servicio y el profesional deben ser de ese negocio
    const reserva = await repositorio.buscarDatosReserva(pool, { empresaId, barberoId, servicioId, fecha });
    if (!reserva) throw errores.noEncontrado('Servicio o profesional no encontrado');

    // 2. Solo desde hoy hasta 14 días después, en hora de Colombia ("AAAA-MM-DD" se compara bien como texto)
    if (fecha < reserva.hoy) throw errores.solicitudInvalida('No se pueden agendar citas en fechas pasadas');
    if (fecha > reserva.ultimo_dia) {
      throw errores.solicitudInvalida(
        `Solo puedes reservar desde hoy hasta ${DIAS_RESERVA} días después (hasta el ${reserva.ultimo_dia}).`,
      );
    }

    // 3. El negocio debe atender ese día, y la cita caber dentro de su horario de ese día
    if (!reserva.horario_apertura || !reserva.horario_cierre) {
      throw errores.solicitudInvalida('El negocio no atiende ese día. Por favor elige otra fecha.');
    }
    const inicio = hora12AMinutos(hora) as number; // el esquema ya validó el formato
    const fin = inicio + reserva.duracion_min;
    if (inicio < hora24AMinutos(reserva.horario_apertura) || fin > hora24AMinutos(reserva.horario_cierre)) {
      throw errores.solicitudInvalida('La hora elegida está fuera del horario del negocio');
    }

    // 4. Ni números de la lista negra del negocio, ni horas que el profesional bloqueó
    if (await repositorio.telefonoEnListaNegra(pool, empresaId, telefono)) {
      throw errores.prohibido('No es posible agendar con este número. Comunícate con el negocio.');
    }
    const horario = { horaInicio: minutosAHHMM(inicio), horaFin: minutosAHHMM(fin) };
    if (await repositorio.chocaConBloqueo(pool, { barberoId, fecha, ...horario })) {
      throw errores.conflicto('El profesional no atiende en ese horario. Por favor elige otra hora.');
    }

    // 5. Cliente y cita juntos: o se guardan los dos, o ninguno. La restricción
    //    citas_sin_solapamiento rechaza la segunda de dos reservas simultáneas.
    const citaId = randomUUID();
    try {
      await enTransaccion(pool, async (tx) => {
        const clienteId = await repositorio.registrarCliente(tx, {
          id: randomUUID(),
          empresaId,
          telefono,
          indicativo,
          nombre,
          fecha,
        });
        await repositorio.insertarCita(tx, {
          id: citaId,
          empresaId,
          barberoId,
          servicioId,
          clienteId,
          fecha,
          ...horario,
          precio: reserva.precio,
        });
      });
    } catch (error) {
      if (esErrorPg(error, CODIGO_PG.violacionExclusion)) throw errores.conflicto(HORA_OCUPADA);
      // El profesional o el servicio se eliminó mientras se reservaba
      if (esErrorPg(error, CODIGO_PG.violacionLlaveForanea)) {
        throw errores.noEncontrado('Servicio o profesional no encontrado');
      }
      throw error;
    }

    return {
      mensaje: 'Cita agendada',
      cita: {
        id: citaId,
        cliente: nombre,
        telefono,
        indicativo,
        servicio: reserva.servicio,
        barberoId,
        barberoNombre: reserva.barbero,
        empresaId,
        fecha,
        hora,
        precio: Number(reserva.precio),
        duracionMin: reserva.duracion_min,
        estado: 'CONFIRMADA',
      },
    };
  },

  // Horas tomadas de un negocio. No incluye nombres ni teléfonos de clientes.
  async horasOcupadas(empresaId: string) {
    const filas = await repositorio.listarOcupadas(pool, empresaId);
    return filas.map((r) => ({
      barberoId: r.barbero_id,
      fecha: r.fecha,
      hora: r.hora,
      duracionMin: r.duracion_min,
      estado: r.estado,
    }));
  },

  // Horarios bloqueados del equipo (semanales o de una fecha), sin el motivo
  async bloqueosPublicos(empresaId: string) {
    const filas = await repositorio.listarBloqueosPublicos(pool, empresaId);
    return filas.map((r) => ({
      barberoId: r.barbero_id,
      tipo: r.dia_semana !== null ? 'semanal' : 'fecha',
      diaSemana: r.dia_semana,
      fecha: r.fecha,
      todoElDia: esDiaCompleto(r),
      horaInicio: r.hora_inicio,
      horaFin: r.hora_fin,
    }));
  },

  // El administrador ve a todo su equipo; un barbero solo ve sus propias citas
  async agenda({ empresaId, barberoId, esAdmin }: Sesion) {
    const filas = await repositorio.listarAgenda(pool, empresaId, esAdmin ? null : barberoId);
    return filas.map((r) => ({
      id: r.id,
      cliente: r.cliente,
      telefono: r.telefono,
      servicio: r.servicio,
      barberoId: r.barbero_id,
      barberoNombre: r.barbero_nombre,
      empresaId: r.empresa_id,
      fecha: r.fecha,
      hora: r.hora,
      precio: Number(r.precio),
      duracionMin: r.duracion_min,
      estado: r.estado,
      completadaEn: r.completada_en ?? undefined,
      completadaPor: r.completada_por ?? undefined,
      canceladaEn: r.cancelada_en ?? undefined,
      canceladaPor: r.cancelada_por ?? undefined,
    }));
  },

  async completar({ empresaId, barberoId, usuarioId }: Sesion, id: string) {
    const r = await repositorio.completarCita(pool, { id, empresaId, barberoId, usuarioId });
    if (!r) {
      throw errores.conflicto(
        'No se pudo completar: la cita no existe, ya fue atendida o cancelada, o no es tuya.',
      );
    }
    return { estado: r.estado, completadaEn: r.completada_en, completadaPor: r.completada_por };
  },

  async cancelar({ empresaId, barberoId, usuarioId }: Sesion, id: string) {
    const r = await repositorio.cancelarCita(pool, { id, empresaId, barberoId, usuarioId });
    if (!r) {
      throw errores.conflicto('No se pudo cancelar: la cita no existe o ya fue atendida o cancelada.');
    }
    return { estado: r.estado, canceladaEn: r.cancelada_en, canceladaPor: r.cancelada_por };
  },
});

export type ServicioCitas = ReturnType<typeof crearServicioCitas>;
