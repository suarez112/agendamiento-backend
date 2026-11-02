import { Router } from 'express';
import type pg from 'pg';
import { registro } from '../registro.js';

// Below Render's own probe timeout, so a stalled database answers 503 instead of leaving the probe hanging
const TIEMPO_MAXIMO_MS = 3_000;

// GET /salud: comprobación de salud para la plataforma (Render la consulta antes de enviar tráfico y durante el
// servicio). Va fuera de /api para no gastar el límite general. Solo dice si el servidor y la base responden:
// nunca la hora, la versión ni el error (hallazgo B-11). Si la base no contesta en tiempoMaximoMs (por ejemplo,
// acepta la conexión pero se queda colgada, o el pool está lleno), responde 503 en lugar de esperar sin límite.
export const crearRutaSalud = (pool: Pick<pg.Pool, 'query'>, opciones: { tiempoMaximoMs?: number } = {}) => {
  const tiempoMaximoMs = opciones.tiempoMaximoMs ?? TIEMPO_MAXIMO_MS;
  const rutas = Router();
  rutas.get('/', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let temporizador: NodeJS.Timeout | undefined;
    try {
      const vencido = new Promise<never>((_, rechazar) => {
        temporizador = setTimeout(() => rechazar(new Error(`la base no contestó en ${tiempoMaximoMs} ms`)), tiempoMaximoMs);
      });
      await Promise.race([pool.query('SELECT 1'), vencido]);
      res.json({ estado: 'ok' });
    } catch (error) {
      registro.error('salud_sin_base', { mensaje: (error as Error).message });
      res.status(503).json({ error: 'Servicio no disponible' });
    } finally {
      clearTimeout(temporizador);
    }
  });
  return rutas;
};
