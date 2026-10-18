import type pg from 'pg';
import type { Sesion } from '../auth/auth.servicio.js';
import * as repositorio from './cartera.repositorio.js';

// Suma con centavos sin errores de punto flotante
const sumar = (valores: number[]) => Math.round(valores.reduce((a, b) => a + b * 100, 0)) / 100;

// Resumen de ganancias: un administrador ve todo el negocio; un barbero, solo lo suyo
export const crearServicioCartera = ({ pool }: { pool: pg.Pool }) => ({
  async resumen(sesion: Sesion, desde: string, hasta: string) {
    const filas = await repositorio.resumenPorProfesional(pool, {
      empresaId: sesion.empresaId,
      desde,
      hasta,
      barberoId: sesion.esAdmin ? null : sesion.barberoId,
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
      totalCitas: porProfesional.reduce((total, p) => total + p.citas, 0),
      totalVentas,
      gananciaEquipo,
      gananciaNegocio: sumar([totalVentas, -gananciaEquipo]),
      porProfesional,
    };
  },
});

export type ServicioCartera = ReturnType<typeof crearServicioCartera>;
