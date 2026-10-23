import type pg from 'pg';
import { type ConsultaPeriodo, resolverPeriodo } from '../cartera/cartera.servicio.js';
import * as repositorio from './reportes.repositorio.js';
import { diasDelRango, minutosDisponibles } from './ocupacion.js';

const redondear1 = (n: number) => Math.round(n * 10) / 10;
const redondear2 = (n: number) => Math.round(n * 100) / 100;
const horas = (minutos: number) => redondear2(minutos / 60);
const porcentaje = (parte: number, total: number) => (total > 0 ? Math.min(100, redondear1((parte / total) * 100)) : 0);

const hhmm = (hora: number) => `${String(hora).padStart(2, '0')}:00`;

// Reportes para administradores. Usan los mismos filtros de período que la cartera (hoy, semana, mes
// o rango, y opcionalmente un profesional). La empresa sale siempre de la sesión.
export const crearServicioReportes = ({ pool }: { pool: pg.Pool }) => {
  const preparar = async (empresaId: string, consulta: ConsultaPeriodo) => {
    const { desde, hasta, limites } = await resolverPeriodo(pool, empresaId, consulta);
    return {
      desde,
      hasta,
      zonaHoraria: limites?.zona_horaria ?? null,
      hoy: limites?.hoy ?? hasta,
      filtro: { empresaId, desde, hasta, barberoId: consulta.barberoId ?? null },
    };
  };

  return {
    // Porcentaje del tiempo disponible (horario del negocio menos bloqueos) que tuvo citas.
    // Solo se mide hasta hoy: los días que aún no llegan no cuentan como tiempo perdido.
    async ocupacion(empresaId: string, consulta: ConsultaPeriodo) {
      const { desde, hasta, zonaHoraria, hoy, filtro } = await preparar(empresaId, consulta);
      const calculadoHasta = hasta < hoy ? hasta : hoy;
      const conTiempo = desde <= calculadoHasta;
      const medido = { ...filtro, hasta: calculadoHasta };

      const [equipo, horario, bloqueos, ocupados] = await Promise.all([
        repositorio.profesionales(pool, empresaId, filtro.barberoId),
        repositorio.horarios(pool, empresaId),
        conTiempo ? repositorio.bloqueos(pool, medido) : [],
        conTiempo ? repositorio.minutosOcupados(pool, medido) : [],
      ]);
      const dias = conTiempo ? diasDelRango(desde, calculadoHasta) : [];
      const horarios = new Map(horario.map((h) => [h.dia, { inicio: h.inicio, fin: h.fin }]));
      const ocupadoDe = new Map(ocupados.map((o) => [o.barbero_id, o.minutos]));

      const porProfesional = equipo.map((b) => ({
        barberoId: b.id,
        nombre: b.nombre,
        minutosDisponibles: minutosDisponibles(
          dias,
          horarios,
          bloqueos
            .filter((x) => x.barbero_id === b.id)
            .map((x) => ({ barberoId: x.barbero_id, diaSemana: x.dia_semana, fecha: x.fecha, inicio: x.inicio, fin: x.fin })),
        ),
        minutosOcupados: ocupadoDe.get(b.id) ?? 0,
      }));
      const totalDisponible = porProfesional.reduce((t, p) => t + p.minutosDisponibles, 0);
      const totalOcupado = porProfesional.reduce((t, p) => t + p.minutosOcupados, 0);

      return {
        desde,
        hasta,
        calculadoHasta: conTiempo ? calculadoHasta : null,
        zonaHoraria,
        barberoId: filtro.barberoId,
        total: {
          horasDisponibles: horas(totalDisponible),
          horasOcupadas: horas(totalOcupado),
          porcentajeOcupacion: porcentaje(totalOcupado, totalDisponible),
        },
        porProfesional: porProfesional.map((p) => ({
          barberoId: p.barberoId,
          nombre: p.nombre,
          horasDisponibles: horas(p.minutosDisponibles),
          horasOcupadas: horas(p.minutosOcupados),
          porcentajeOcupacion: porcentaje(p.minutosOcupados, p.minutosDisponibles),
        })),
      };
    },

    // Ingresos por servicio (citas completadas) e ingreso por hora trabajada de cada uno
    async serviciosRentables(empresaId: string, consulta: ConsultaPeriodo) {
      const { desde, hasta, zonaHoraria, filtro } = await preparar(empresaId, consulta);
      const filas = await repositorio.serviciosRentables(pool, filtro);

      const servicios = filas
        .map((f) => {
          const ingresos = Number(f.ingresos);
          return {
            servicioId: f.servicio_id,
            nombre: f.nombre,
            citas: f.citas,
            ingresos,
            horasTrabajadas: horas(f.minutos),
            ingresoPorHora: f.minutos > 0 ? redondear2(ingresos / (f.minutos / 60)) : 0,
            ticketPromedio: redondear2(ingresos / f.citas),
          };
        })
        .sort((a, b) => b.ingresos - a.ingresos || b.ingresoPorHora - a.ingresoPorHora || a.nombre.localeCompare(b.nombre));

      const ingresos = redondear2(servicios.reduce((t, s) => t + s.ingresos, 0));
      const minutos = filas.reduce((t, f) => t + f.minutos, 0);
      const mejorPorHora = servicios.reduce<(typeof servicios)[number] | null>(
        (m, s) => (s.ingresoPorHora > 0 && (!m || s.ingresoPorHora > m.ingresoPorHora) ? s : m),
        null,
      );
      return {
        desde,
        hasta,
        zonaHoraria,
        barberoId: filtro.barberoId,
        total: {
          citas: filas.reduce((t, f) => t + f.citas, 0),
          ingresos,
          horasTrabajadas: horas(minutos),
          ingresoPorHora: minutos > 0 ? redondear2(ingresos / (minutos / 60)) : 0,
        },
        servicioMayorIngreso: servicios[0]?.servicioId ?? null,
        servicioMayorIngresoPorHora: mejorPorHora?.servicioId ?? null,
        servicios,
      };
    },

    // Cantidad de citas (no canceladas) por día de la semana y hora de inicio
    async demanda(empresaId: string, consulta: ConsultaPeriodo) {
      const { desde, hasta, zonaHoraria, filtro } = await preparar(empresaId, consulta);
      const filas = await repositorio.demanda(pool, filtro);

      const porDia = Array.from({ length: 7 }, (_, dia) => ({ dia, citas: 0 }));
      const porHora = new Map<number, number>();
      for (const f of filas) {
        porDia[f.dia].citas += f.citas;
        porHora.set(f.hora, (porHora.get(f.hora) ?? 0) + f.citas);
      }
      const masAlto = <T extends { citas: number }>(lista: T[]) =>
        lista.reduce<T | null>((m, x) => (x.citas > 0 && (!m || x.citas > m.citas) ? x : m), null);
      const porHoraLista = [...porHora].sort(([a], [b]) => a - b).map(([hora, citas]) => ({ hora: hhmm(hora), citas }));
      const mapa = filas
        .map((f) => ({ dia: f.dia, hora: hhmm(f.hora), citas: f.citas }))
        .sort((a, b) => a.dia - b.dia || a.hora.localeCompare(b.hora));

      return {
        desde,
        hasta,
        zonaHoraria,
        barberoId: filtro.barberoId,
        totalCitas: porDia.reduce((t, d) => t + d.citas, 0),
        porDiaSemana: porDia,
        porHora: porHoraLista,
        mapa,
        diaMasDemandado: masAlto(porDia)?.dia ?? null,
        horaMasDemandada: masAlto(porHoraLista)?.hora ?? null,
        pico: masAlto(mapa),
      };
    },
  };
};

export type ServicioReportes = ReturnType<typeof crearServicioReportes>;
