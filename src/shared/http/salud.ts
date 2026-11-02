import { Router } from 'express';
import type pg from 'pg';
import { registro } from '../registro.js';

// GET /salud: comprobación de salud para la plataforma (Render la consulta antes de enviar tráfico y durante el
// servicio). Va fuera de /api para no gastar el límite general. Solo dice si el servidor y la base responden:
// nunca la hora, la versión ni el error (hallazgo B-11).
export const crearRutaSalud = (pool: Pick<pg.Pool, 'query'>) => {
  const rutas = Router();
  rutas.get('/', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await pool.query('SELECT 1');
      res.json({ estado: 'ok' });
    } catch (error) {
      registro.error('salud_sin_base', { mensaje: (error as Error).message });
      res.status(503).json({ error: 'Servicio no disponible' });
    }
  });
  return rutas;
};
