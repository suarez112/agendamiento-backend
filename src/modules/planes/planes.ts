import { Router } from 'express';
import { PLANES } from '../../config/planes.js';

// GET /api/v1/planes: planes por tamaño de equipo con sus precios (públicos)
export const crearRutasPlanes = () => {
  const rutas = Router();
  const respuesta = PLANES.map((p) => ({
    id: p.id,
    nombre: p.nombre,
    cupo: p.cupo,
    precioMensual: p.precioMensual,
    precioAnual: p.precioAnual,
    moneda: 'COP',
  }));
  rutas.get('/', (_req, res) => {
    res.json(respuesta);
  });
  return rutas;
};
