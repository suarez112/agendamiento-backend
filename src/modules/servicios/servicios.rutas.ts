import { Router } from 'express';
import { z } from 'zod';
import { conAlMenosUnDato, esquemaId, precio, texto } from '../../shared/http/esquemas.js';
import { parsear } from '../../shared/http/validacion.js';
import { sesionDe } from '../auth/guardias.js';
import type { Permisos } from '../auth/permisos.js';
import type { ServicioServicios } from './servicios.servicio.js';

const MENSAJE_DURACION = 'La duración debe ser un múltiplo de 10 minutos, de 10 a 150 (2 h 30)';

const esquemaServicio = z.object(
  {
    nombre: texto('nombre', 100),
    duracionMin: z
      .number({ error: MENSAJE_DURACION })
      .int(MENSAJE_DURACION)
      .min(10, MENSAJE_DURACION)
      .max(150, MENSAJE_DURACION)
      .refine((m) => m % 10 === 0, MENSAJE_DURACION),
    precio: precio('precio'),
  },
  { error: 'Envía los datos del servicio' },
);

const esquemaCambios = conAlMenosUnDato(esquemaServicio.partial());
const esquemaIdServicio = esquemaId('Identificador de servicio inválido');

// Servicios del negocio de la sesión. Solo administradores (los empleados solo usan
// su agenda y su cartera).
export const crearRutasServicios = (servicios: ServicioServicios, permisos: Permisos) => {
  const rutas = Router();

  rutas.get('/', ...permisos.admin, async (_req, res) => {
    res.json(await servicios.listar(sesionDe(res).empresaId));
  });

  rutas.post('/', ...permisos.admin, async (req, res) => {
    const datos = parsear(esquemaServicio, req.body);
    res.status(201).json(await servicios.crear(sesionDe(res).empresaId, datos));
  });

  rutas.patch('/:id', ...permisos.admin, async (req, res) => {
    const { id } = parsear(esquemaIdServicio, req.params);
    res.json(await servicios.actualizar(sesionDe(res).empresaId, id, parsear(esquemaCambios, req.body)));
  });

  rutas.delete('/:id', ...permisos.admin, async (req, res) => {
    const { id } = parsear(esquemaIdServicio, req.params);
    res.json(await servicios.borrar(sesionDe(res).empresaId, id));
  });

  return rutas;
};
