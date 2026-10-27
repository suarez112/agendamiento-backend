import { Router } from 'express';
import type { ServicioCategorias } from './categorias.servicio.js';

// GET /api/v1/categorias: categorías de negocio activas (públicas, para el formulario de registro)
export const crearRutasCategorias = (categorias: ServicioCategorias) => {
  const rutas = Router();
  rutas.get('/', async (_req, res) => {
    res.json(await categorias.listarActivas());
  });
  return rutas;
};
