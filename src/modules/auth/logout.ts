import { Router } from 'express';
import type pg from 'pg';
import { enTransaccion } from '../../db/pool.js';
import type { Titular } from '../notificaciones/notificaciones.repositorio.js';
import { tokenDe } from './guardias.js';
import * as repositorio from './auth.repositorio.js';

// POST /api/v1/logout: cierra la sesión EN EL SERVIDOR. Sirve a cualquier sesión (personal, administradora o
// cliente con cuenta). Sube la versión de sesión de quien la pide: este token y todos los anteriores suyos
// (también los de otros celulares) dejan de servir, aunque no hayan vencido; y se borran sus celulares
// registrados para notificaciones push. La app debe borrar también el token que guarda.
// Un token inválido o vencido responde 401, como en el resto de endpoints.
export const crearRutasLogout = (pool: pg.Pool, titularDe: (jwt: string | undefined) => Promise<Titular>) => {
  const rutas = Router();

  rutas.post('/', async (req, res) => {
    const titular = await titularDe(tokenDe(req));
    await enTransaccion(pool, async (tx) => {
      if (titular.barberoId) await repositorio.cerrarSesionPersonal(tx, titular.barberoId);
      else if (titular.usuarioId) await repositorio.cerrarSesionCuenta(tx, titular.usuarioId);
    });
    res.json({ mensaje: 'Sesión cerrada' });
  });

  return rutas;
};
