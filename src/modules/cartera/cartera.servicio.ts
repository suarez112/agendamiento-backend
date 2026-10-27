import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import type { Sesion } from '../auth/auth.servicio.js';
import * as repositorio from './cartera.repositorio.js';

export const PROFESIONAL_NO_ENCONTRADO = 'Profesional no encontrado';

// Un administrador solo puede filtrar por un profesional de su propio negocio: otro id responde 404,
// igual que el resto de los endpoints
export const exigirProfesionalDelNegocio = async (pool: pg.Pool, empresaId: string, barberoId: string | null | undefined) => {
  if (barberoId && !(await repositorio.existeProfesional(pool, empresaId, barberoId))) {
    throw errores.noEncontrado(PROFESIONAL_NO_ENCONTRADO);
  }
};

export type ConsultaPeriodo = { barberoId?: string } & (
  | { periodo: repositorio.Periodo }
  | { periodo: 'rango'; desde: string; hasta: string }
);

// Con qué se compara: el período anterior (por defecto), el mismo rango un mes o un año
// antes, o un rango de fechas elegido
export type Comparacion =
  | { tipo: 'anterior' | 'mes_pasado' | 'anio_pasado' }
  | { tipo: 'personalizado'; desde: string; hasta: string };

// Secciones del resumen que dependen del plan (src/config/funciones.ts); sin ellas llegan en null
export type Incluye = { compararPeriodos: boolean; comisiones: boolean; demanda: boolean };
const TODO_INCLUIDO: Incluye = { compararPeriodos: true, comisiones: true, demanda: true };

const DIA_MS = 86_400_000;
const SERVICIOS_TOP = 10;

// Resta meses a una fecha AAAA-MM-DD; si el día no existe en ese mes, usa el último
// (31 de marzo menos un mes = 28 de febrero)
const restarMeses = (fecha: string, meses: number) => {
  const [anio, mes, dia] = fecha.split('-').map(Number);
  const destino = new Date(Date.UTC(anio, mes - 1 - meses, 1));
  const ultimoDia = new Date(Date.UTC(destino.getUTCFullYear(), destino.getUTCMonth() + 1, 0)).getUTCDate();
  destino.setUTCDate(Math.min(dia, ultimoDia));
  return destino.toISOString().slice(0, 10);
};

const redondear1 = (n: number) => Math.round(n * 10) / 10;

// Cambio en % respecto al período anterior (negativo = bajó). Sin base (anterior en 0): 0 si
// tampoco hay ahora, y null si ahora sí hay (no se puede calcular un porcentaje)
const variacion = (actual: number, anterior: number) =>
  anterior === 0 ? (actual === 0 ? 0 : null) : redondear1(((actual - anterior) / anterior) * 100);

// Período anterior, completo, con el que se compara: el mes anterior para "mes"; para los
// demás, los mismos días justo antes de "desde" (ayer, la semana pasada o el rango anterior)
const periodoAnterior = (periodo: string, desde: string, hasta: string) => {
  const fin = Date.parse(desde) - DIA_MS;
  const finTexto = new Date(fin).toISOString().slice(0, 10);
  if (periodo === 'mes') return { desde: `${finTexto.slice(0, 8)}01`, hasta: finTexto };
  const dias = (Date.parse(hasta) - Date.parse(desde)) / DIA_MS + 1;
  return { desde: new Date(fin - (dias - 1) * DIA_MS).toISOString().slice(0, 10), hasta: finTexto };
};

// Suma con centavos sin errores de punto flotante
const sumar = (valores: number[]) => Math.round(valores.reduce((a, b) => a + b * 100, 0)) / 100;

// Fechas de una consulta por período (hoy, semana, mes o rango) en la zona del negocio. Un rango no puede
// empezar antes del registro del negocio ni terminar después de hoy. Lo comparten la cartera y los reportes.
export const resolverPeriodo = async (pool: pg.Pool, empresaId: string, consulta: ConsultaPeriodo) => {
  const limites = await repositorio.limitesDeRango(pool, empresaId);
  if (consulta.periodo === 'rango') {
    if (limites?.fecha_registro && consulta.desde < limites.fecha_registro) {
      throw errores.solicitudInvalida(
        `La fecha "desde" no puede ser anterior a la fecha de registro del negocio (${limites.fecha_registro}).`,
      );
    }
    if (limites && consulta.hasta > limites.hoy) {
      throw errores.solicitudInvalida(`La fecha "hasta" no puede ser posterior a hoy (${limites.hoy}).`);
    }
  }
  const { desde, hasta } =
    consulta.periodo === 'rango' ? consulta : await repositorio.fechasDePeriodo(pool, empresaId, consulta.periodo);
  return { desde, hasta, limites };
};

// Resumen de ganancias: un administrador ve todo el negocio y puede filtrar por un
// integrante (también él mismo); un empleado solo ve lo suyo, aunque envíe otro barberoId
export const crearServicioCartera = ({ pool }: { pool: pg.Pool }) => ({
  // Resumen de un período: hoy, esta semana, este mes o un rango de fechas. Mismas
  // reglas de acceso que resumen(). Los profesionales van de mayor a menor en ventas.
  // Un rango no puede empezar antes del registro del negocio ni terminar después de hoy
  // (fechas en la zona del negocio). Las fechas AAAA-MM-DD se comparan bien como texto.
  async resumenPeriodo(
    sesion: Sesion,
    consulta: ConsultaPeriodo,
    comparar: Comparacion = { tipo: 'anterior' },
    incluye: Incluye = TODO_INCLUIDO,
  ) {
    const { desde, hasta, limites } = await resolverPeriodo(pool, sesion.empresaId, consulta);
    // Sin comisiones en el plan no hay reparto con el equipo: toda la venta es del negocio
    const resumir = async (d: string, h: string) => {
      const x = await this.resumen(sesion, d, h, consulta.barberoId);
      return incluye.comisiones ? x : { ...x, gananciaEquipo: 0, gananciaNegocio: x.totalVentas };
    };
    const r = await resumir(desde, hasta);

    // Mismo filtro que el resumen: un empleado solo ve lo suyo, aunque envíe otro barberoId
    const filtro = { empresaId: sesion.empresaId, desde, hasta, barberoId: r.barberoId };
    const anterior =
      comparar.tipo === 'personalizado'
        ? { desde: comparar.desde, hasta: comparar.hasta }
        : comparar.tipo === 'mes_pasado'
          ? { desde: restarMeses(desde, 1), hasta: restarMeses(hasta, 1) }
          : comparar.tipo === 'anio_pasado'
            ? { desde: restarMeses(desde, 12), hasta: restarMeses(hasta, 12) }
            : periodoAnterior(consulta.periodo, desde, hasta);

    // Un rango elegido que empieza antes del registro del negocio no tiene datos: llega en ceros con un aviso
    const antesDelRegistro =
      comparar.tipo !== 'anterior' && !!limites?.fecha_registro && anterior.desde < limites.fecha_registro;
    const aviso = antesDelRegistro
      ? `El período de comparación (${anterior.desde} a ${anterior.hasta}) empieza antes del registro del negocio (${limites?.fecha_registro}); se muestra en ceros.`
      : null;
    const sinDatos = { totalVentas: 0, gananciaNegocio: 0, gananciaEquipo: 0, totalCitas: 0 };

    const [previo, dias, servicios, ocupacion, cancelaciones, clientes] = await Promise.all([
      antesDelRegistro || !incluye.compararPeriodos ? Promise.resolve(sinDatos) : resumir(anterior.desde, anterior.hasta),
      repositorio.ventasPorDia(pool, filtro),
      repositorio.serviciosMasVendidos(pool, filtro, SERVICIOS_TOP),
      incluye.demanda ? repositorio.ocupacion(pool, filtro) : Promise.resolve([]),
      repositorio.conteoCancelaciones(pool, filtro),
      repositorio.clientesNuevosYRecurrentes(pool, filtro),
    ]);

    // Citas por día de la semana (0 = domingo … 6 = sábado, los 7) y por hora (solo las que tienen citas)
    const porDia = Array.from({ length: 7 }, (_, dia) => ({ dia, citas: 0 }));
    const porHora = new Map<number, number>();
    for (const o of ocupacion) {
      porDia[o.dia].citas += o.citas;
      porHora.set(o.hora, (porHora.get(o.hora) ?? 0) + o.citas);
    }
    const horas = [...porHora].sort(([a], [b]) => a - b).map(([hora, citas]) => ({ hora: `${String(hora).padStart(2, '0')}:00`, citas }));
    const masOcupado = <T extends { citas: number }>(filas: T[]) =>
      filas.reduce<T | null>((m, f) => (f.citas > 0 && (!m || f.citas > m.citas) ? f : m), null);

    const pagoProfesionales = r.porProfesional.map((p) => ({
      barberoId: p.barberoId,
      nombre: p.nombre,
      activo: p.activo,
      porcentajeGanancia: p.porcentajeGanancia,
      citas: p.citas,
      ventas: p.ventas,
      aPagar: p.ganancia,
    }));

    return {
      periodo: consulta.periodo,
      desde,
      hasta,
      zonaHoraria: limites?.zona_horaria ?? null,
      barberoId: r.barberoId,
      totalVentas: r.totalVentas,
      gananciaNegocio: r.gananciaNegocio,
      citasCompletadas: r.totalCitas,
      porProfesional: r.porProfesional.map((p) => ({
        barberoId: p.barberoId,
        nombre: p.nombre,
        activo: p.activo,
        citas: p.citas,
        ventas: p.ventas,
        ...(incluye.comisiones ? { ganancia: p.ganancia } : {}),
      })),
      ticketPromedio: r.totalCitas ? Math.round((r.totalVentas / r.totalCitas) * 100) / 100 : 0,
      comparacion: !incluye.compararPeriodos ? null : {
        tipo: comparar.tipo,
        aviso,
        periodoAnterior: {
          desde: anterior.desde,
          hasta: anterior.hasta,
          totalVentas: previo.totalVentas,
          gananciaNegocio: previo.gananciaNegocio,
          gananciaEquipo: previo.gananciaEquipo,
          citasCompletadas: previo.totalCitas,
        },
        variacionPorcentaje: {
          ventas: variacion(r.totalVentas, previo.totalVentas),
          gananciaNegocio: variacion(r.gananciaNegocio, previo.gananciaNegocio),
          gananciaEquipo: variacion(r.gananciaEquipo, previo.gananciaEquipo),
          citas: variacion(r.totalCitas, previo.totalCitas),
        },
      },
      ventasPorDia: dias.map((d) => ({ fecha: d.fecha, ventas: Number(d.ventas), citas: d.citas })),
      serviciosMasVendidos: servicios.map((s) => ({
        servicioId: s.servicio_id,
        nombre: s.nombre,
        cantidad: s.cantidad,
        ventas: Number(s.ventas),
      })),
      ocupacion: !incluye.demanda ? null : {
        diasSemana: porDia,
        horas,
        diaMasOcupado: masOcupado(porDia)?.dia ?? null,
        horaMasOcupada: masOcupado(horas)?.hora ?? null,
      },
      cancelaciones: {
        totalCitas: cancelaciones.total,
        canceladas: cancelaciones.canceladas,
        tasaPorcentaje: cancelaciones.total ? redondear1((cancelaciones.canceladas / cancelaciones.total) * 100) : 0,
      },
      clientes: { nuevos: clientes.nuevos, recurrentes: clientes.recurrentes },
      pagoProfesionales: incluye.comisiones ? { total: r.gananciaEquipo, detalle: pagoProfesionales } : null,
    };
  },

  async resumen(sesion: Sesion, desde: string, hasta: string, filtro?: string) {
    if (sesion.esAdmin) await exigirProfesionalDelNegocio(pool, sesion.empresaId, filtro);
    const filas = await repositorio.resumenPorProfesional(pool, {
      empresaId: sesion.empresaId,
      desde,
      hasta,
      barberoId: sesion.esAdmin ? (filtro ?? null) : sesion.barberoId,
    });

    const porProfesional = filas.map((f) => ({
      barberoId: f.barbero_id,
      nombre: f.nombre,
      activo: f.activo,
      porcentajeGanancia: Number(f.porcentaje_ganancia),
      citas: f.citas,
      ventas: Number(f.ventas),
      ganancia: Number(f.ganancia),
    }));

    const totalVentas = sumar(porProfesional.map((p) => p.ventas));
    const gananciaEquipo = sumar(porProfesional.map((p) => p.ganancia));
    return {
      desde,
      hasta,
      barberoId: sesion.esAdmin ? (filtro ?? null) : sesion.barberoId,
      totalCitas: porProfesional.reduce((total, p) => total + p.citas, 0),
      totalVentas,
      gananciaEquipo,
      gananciaNegocio: sumar([totalVentas, -gananciaEquipo]),
      porProfesional,
    };
  },
});

export type ServicioCartera = ReturnType<typeof crearServicioCartera>;
