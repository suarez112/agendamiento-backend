import { Router } from 'express';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { type Guardias, sesionDe } from '../auth/guardias.js';
import type { ServicioEmpresas } from './empresas.servicio.js';

export const crearRutasEmpresas = (
  empresas: ServicioEmpresas,
  guardias: Guardias,
  limitadores: Limitadores,
) => {
  const rutas = Router();

  rutas.get('/validar/:codigo', limitadores.codigoNegocio, async (req, res) => {
    res.json(await empresas.negocioPorCodigo(String(req.params.codigo)));
  });

  rutas.get('/actual', guardias.requerirSesion, async (_req, res) => {
    res.json(await empresas.negocioDeSesion(sesionDe(res).empresaId));
  });

  return rutas;
};
