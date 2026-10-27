import type pg from 'pg';
import { type ConsultaPeriodo, exigirProfesionalDelNegocio, resolverPeriodo } from '../cartera/cartera.servicio.js';
import * as repositorio from './reportes.repositorio.js';
import { diasDelRango, minutosDisponibles } from './ocupacion.js';

const redondear1 = (n: number) => Math.round(n * 10) / 10;
const redondear2 = (n: number) => Math.round(n * 100) / 100;
const horas = (minutos: number) => redondear2(minutos / 60);
const porcentaje = (parte: number, total: number) => (total > 0 ? Math.min(100, redondear1((parte / total) * 100)) : 0);

const CLIENTES_TOP = 10;

const hhmm = (hora: number) => `${String(hora).padStart(2, '0')}:00`;

// Reportes para administradores. Usan los mismos filtros de período que la cartera (hoy, semana, mes
// o rango, y opcionalmente un profesional). La empresa sale siempre de la sesión.
export const crearServicioReportes = ({ pool }: { pool: pg.Pool }) => {
  const preparar = async (empresaId: string, consulta: ConsultaPeriodo) => {
    await exigirProfesionalDelNegocio(pool, empresaId, consulta.barberoId);
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

    // Reportes avanzados (plan Pro). Los clientes que más gastan y los que más vienen (citas completadas)
    async mejoresClientes(empresaId: string, consulta: ConsultaPeriodo) {
      const { desde, hasta, zonaHoraria, filtro } = await preparar(empresaId, consulta);
      const filas = (await repositorio.clientesDelPeriodo(pool, filtro)).map((f) => ({
        clienteId: f.cliente_id,
        nombre: f.nombre,
        visitas: f.visitas,
        gasto: Number(f.gasto),
        ticketPromedio: redondear2(Number(f.gasto) / f.visitas),
        ultimaVisita: f.ultima_visita,
      }));
      const top = (orden: (a: (typeof filas)[number], b: (typeof filas)[number]) => number) =>
        [...filas].sort((a, b) => orden(a, b) || a.nombre.localeCompare(b.nombre)).slice(0, CLIENTES_TOP);
      return {
        desde,
        hasta,
        zonaHoraria,
        barberoId: filtro.barberoId,
        totalClientes: filas.length,
        masGastan: top((a, b) => b.gasto - a.gasto || b.visitas - a.visitas),
        masVienen: top((a, b) => b.visitas - a.visitas || b.gasto - a.gasto),
      };
    },

    // Clientes que volvieron (2 o más citas completadas en total hasta el fin del período) frente a los que
    // vinieron una sola vez, entre quienes tuvieron una cita completada en el período
    async retencionClientes(empresaId: string, consulta: ConsultaPeriodo) {
      const { desde, hasta, zonaHoraria, filtro } = await preparar(empresaId, consulta);
      const r = await repositorio.retencionDeClientes(pool, filtro);
      const total = r.volvieron + r.una_vez;
      return {
        desde,
        hasta,
        zonaHoraria,
        barberoId: filtro.barberoId,
        totalClientes: total,
        volvieron: r.volvieron,
        unaSolaVez: r.una_vez,
        porcentajeVolvieron: porcentaje(r.volvieron, total),
        porcentajeUnaSolaVez: total > 0 ? redondear1(100 - porcentaje(r.volvieron, total)) : 0,
      };
    },

    // Ventas y citas mes a mes dentro del período (todos los meses, con ceros). La variación compara
    // cada mes con el anterior de la lista.
    async tendencia(empresaId: string, consulta: ConsultaPeriodo) {
      const { desde, hasta, zonaHoraria, filtro } = await preparar(empresaId, consulta);
      const filas = await repositorio.tendenciaMensual(pool, filtro);
      const variacion = (actual: number, anterior: number | undefined) =>
        anterior === undefined ? null : anterior === 0 ? (actual === 0 ? 0 : null) : redondear1(((actual - anterior) / anterior) * 100);
      const meses = filas.map((f, i) => {
        const ventas = Number(f.ventas);
        const previo = i > 0 ? filas[i - 1] : undefined;
        return {
          mes: f.mes,
          ventas,
          citas: f.citas,
          completadas: f.completadas,
          canceladas: f.canceladas,
          variacionVentas: variacion(ventas, previo ? Number(previo.ventas) : undefined),
          variacionCitas: variacion(f.citas, previo?.citas),
        };
      });
      return { desde, hasta, zonaHoraria, barberoId: filtro.barberoId, meses };
    },
  };
};

export type ServicioReportes = ReturnType<typeof crearServicioReportes>;
