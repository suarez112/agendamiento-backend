import { Router } from 'express';
import { parsear } from '../../shared/http/validacion.js';
import { sesionDe } from '../auth/guardias.js';
import type { Permisos } from '../auth/permisos.js';
import { esquemaPeriodo } from '../cartera/cartera.rutas.js';
import type { ServicioReportes } from './reportes.servicio.js';

// Reportes solo para administradores, con los mismos filtros de período de la cartera:
// ?periodo=hoy|semana|mes|rango (con desde y hasta) y, opcional, barberoId
export const crearRutasReportes = (reportes: ServicioReportes, permisos: Permisos) => {
  const rutas = Router();

  rutas.get('/ocupacion', ...permisos.admin, async (req, res) => {
    res.json(await reportes.ocupacion(sesionDe(res).empresaId, parsear(esquemaPeriodo, req.query)));
  });

  rutas.get('/servicios-rentables', ...permisos.admin, async (req, res) => {
    res.json(await reportes.serviciosRentables(sesionDe(res).empresaId, parsear(esquemaPeriodo, req.query)));
  });

  rutas.get('/demanda', ...permisos.admin, async (req, res) => {
    res.json(await reportes.demanda(sesionDe(res).empresaId, parsear(esquemaPeriodo, req.query)));
  });

  return rutas;
};
