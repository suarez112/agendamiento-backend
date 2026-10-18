import { Router } from 'express';
import { z } from 'zod';
import { esquemaId, hora, textoOpcional } from '../../shared/http/esquemas.js';
import { parsear } from '../../shared/http/validacion.js';
import { sesionDe } from '../auth/guardias.js';
import type { Permisos } from '../auth/permisos.js';
import type { ServicioBloqueos } from './bloqueos.servicio.js';

const MENSAJE_DIA = 'El día debe ser un número del 0 (domingo) al 6 (sábado)';
const MENSAJE_BARBERO = 'Identificador de profesional inválido';

const idBarbero = z.string({ error: MENSAJE_BARBERO }).trim().min(1, MENSAJE_BARBERO).max(64, MENSAJE_BARBERO);

const esquemaBloqueo = z
  .object(
    {
      barberoId: idBarbero.optional(),
      diaSemana: z.number({ error: MENSAJE_DIA }).int(MENSAJE_DIA).min(0, MENSAJE_DIA).max(6, MENSAJE_DIA),
      horaInicio: hora('hora de inicio'),
      horaFin: hora('hora de fin'),
      motivo: textoOpcional('motivo', 200),
    },
    { error: 'Envía los datos del bloqueo' },
  )
  // "HH:MM" se compara bien como texto
  .refine((d) => d.horaFin > d.horaInicio, 'La hora de fin debe ser posterior a la hora de inicio');

const esquemaFiltro = z.object({ barberoId: idBarbero.optional() });
const esquemaIdBloqueo = esquemaId('Identificador de bloqueo inválido');

// Bloqueos semanales de horario del negocio de la sesión
export const crearRutasBloqueos = (bloqueos: ServicioBloqueos, permisos: Permisos) => {
  const rutas = Router();

  rutas.get('/', ...permisos.personal, async (req, res) => {
    const { barberoId } = parsear(esquemaFiltro, req.query);
    res.json(await bloqueos.listar(sesionDe(res), barberoId));
  });

  rutas.post('/', ...permisos.personal, async (req, res) => {
    res.status(201).json(await bloqueos.crear(sesionDe(res), parsear(esquemaBloqueo, req.body)));
  });

  rutas.delete('/:id', ...permisos.personal, async (req, res) => {
    const { id } = parsear(esquemaIdBloqueo, req.params);
    res.json(await bloqueos.borrar(sesionDe(res), id));
  });

  return rutas;
};
