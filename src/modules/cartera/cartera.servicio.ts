import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import type { Sesion } from '../auth/auth.servicio.js';
import * as repositorio from './cartera.repositorio.js';

export type ConsultaPeriodo = { barberoId?: string } & (
  | { periodo: repositorio.Periodo }
  | { periodo: 'rango'; desde: string; hasta: string }
);

// Suma con centavos sin errores de punto flotante
const sumar = (valores: number[]) => Math.round(valores.reduce((a, b) => a + b * 100, 0)) / 100;

// Resumen de ganancias: un administrador ve todo el negocio y puede filtrar por un
// integrante (también él mismo); un empleado solo ve lo suyo, aunque envíe otro barberoId
export const crearServicioCartera = ({ pool }: { pool: pg.Pool }) => ({
  // Resumen de un período: hoy, esta semana, este mes o un rango de fechas. Mismas
  // reglas de acceso que resumen(). Los profesionales van de mayor a menor en ventas.
  // Un rango no puede empezar antes del registro del negocio ni terminar después de hoy
  // (fechas de Colombia). Las fechas AAAA-MM-DD se comparan bien como texto.
  async resumenPeriodo(sesion: Sesion, consulta: ConsultaPeriodo) {
    if (consulta.periodo === 'rango') {
      const limites = await repositorio.limitesDeRango(pool, sesion.empresaId);
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
      consulta.periodo === 'rango' ? consulta : await repositorio.fechasDePeriodo(pool, consulta.periodo);
    const r = await this.resumen(sesion, desde, hasta, consulta.barberoId);
    return {
      periodo: consulta.periodo,
      desde,
      hasta,
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
        ganancia: p.ganancia,
      })),
    };
  },

  async resumen(sesion: Sesion, desde: string, hasta: string, filtro?: string) {
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
