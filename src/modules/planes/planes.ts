import { Router } from 'express';
import { COBRO, DESCUENTO_ANUAL, PLANES, precioPara } from '../../config/planes.js';

// GET /api/v1/planes: cobro por profesional, niveles y lo que cuesta cada cantidad de profesionales (público)
export const crearRutasPlanes = () => {
  const rutas = Router();
  const respuesta = {
    moneda: 'COP',
    precioPrimerProfesional: COBRO.precioPrimerProfesional,
    precioProfesionalAdicional: COBRO.precioProfesionalAdicional,
    maximoProfesionales: COBRO.maxProfesionales,
    maximoAdminsSinAtender: COBRO.maxAdminsSinAtender,
    descuentoAnual: DESCUENTO_ANUAL,
    niveles: PLANES.map((p) => ({ id: p.id, nombre: p.nombre, profesionalesDesde: p.personasDesde, profesionalesHasta: p.cupo })),
    precios: Array.from({ length: COBRO.maxProfesionales }, (_, i) => ({
      profesionales: i + 1,
      mensual: precioPara(i + 1, 'mensual'),
      anual: precioPara(i + 1, 'anual'),
    })),
  };
  rutas.get('/', (_req, res) => {
    res.json(respuesta);
  });
  return rutas;
};
