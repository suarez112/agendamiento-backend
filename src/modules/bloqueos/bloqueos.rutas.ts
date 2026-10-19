import { Router } from 'express';
import { z } from 'zod';
import { esquemaId, fecha, hora, textoOpcional } from '../../shared/http/esquemas.js';
import { parsear } from '../../shared/http/validacion.js';
import { sesionDe } from '../auth/guardias.js';
import type { Permisos } from '../auth/permisos.js';
import { DIA_COMPLETO, type DatosBloqueo, type ServicioBloqueos } from './bloqueos.servicio.js';

const MENSAJE_DIA = 'El día debe ser un número del 0 (domingo) al 6 (sábado)';
const MENSAJE_BARBERO = 'Identificador de profesional inválido';
const ELIGE_BARBERO = 'Elige el profesional en "barberoId"';
const ELIGE_TIPO =
  'Envía "diaSemana" para un bloqueo que se repite cada semana, o "fecha" para un bloqueo de solo ese día (solo uno de los dos)';
const FALTAN_HORAS = 'Envía "horaInicio" y "horaFin", o "todoElDia": true para bloquear el día completo';
const MENSAJE_HORAS = 'La hora de fin debe ser posterior a la hora de inicio';

const idBarbero = z.string({ error: MENSAJE_BARBERO }).trim().min(1, MENSAJE_BARBERO).max(64, MENSAJE_BARBERO);

// Semanal: { diaSemana, horaInicio, horaFin }. Solo ese día: { fecha, horaInicio, horaFin }
// o { fecha, todoElDia: true }. todoElDia también sirve con diaSemana.
const esquemaBloqueo = z
  .object(
    {
      barberoId: z.string({ error: ELIGE_BARBERO }).pipe(idBarbero),
      diaSemana: z
        .number({ error: MENSAJE_DIA })
        .int(MENSAJE_DIA)
        .min(0, MENSAJE_DIA)
        .max(6, MENSAJE_DIA)
        .nullish(),
      fecha: fecha('fecha').nullish(),
      todoElDia: z.boolean({ error: 'El campo "todoElDia" debe ser true o false' }).optional(),
      horaInicio: hora('hora de inicio').optional(),
      horaFin: hora('hora de fin').optional(),
      motivo: textoOpcional('motivo', 200),
    },
    { error: 'Envía los datos del bloqueo' },
  )
  .superRefine((d, ctx) => {
    if ((d.diaSemana == null) === (d.fecha == null)) {
      ctx.addIssue({ code: 'custom', message: ELIGE_TIPO });
    } else if (!d.todoElDia && (!d.horaInicio || !d.horaFin)) {
      ctx.addIssue({ code: 'custom', message: FALTAN_HORAS });
    } else if (!d.todoElDia && d.horaFin! <= d.horaInicio!) {
      // "HH:MM" se compara bien como texto
      ctx.addIssue({ code: 'custom', message: MENSAJE_HORAS });
    }
  })
  .transform(
    (d): DatosBloqueo => ({
      barberoId: d.barberoId,
      diaSemana: d.diaSemana ?? null,
      fecha: d.fecha ?? null,
      ...(d.todoElDia ? DIA_COMPLETO : { horaInicio: d.horaInicio!, horaFin: d.horaFin! }),
      motivo: d.motivo ?? null,
    }),
  );

const esquemaFiltro = z.object({ barberoId: idBarbero.optional() });
const esquemaIdBloqueo = esquemaId('Identificador de bloqueo inválido');

// Bloqueos de horario del negocio de la sesión: semanales o de solo ese día
export const crearRutasBloqueos = (bloqueos: ServicioBloqueos, permisos: Permisos) => {
  const rutas = Router();

  // Solo el administrador: ve los bloqueos de todo el equipo (o de un integrante).
  // Los empleados no ven ni usan bloqueos.
  rutas.get('/', ...permisos.admin, async (req, res) => {
    const { barberoId } = parsear(esquemaFiltro, req.query);
    res.json(await bloqueos.listar(sesionDe(res), barberoId));
  });

  rutas.post('/', ...permisos.admin, async (req, res) => {
    res.status(201).json(await bloqueos.crear(sesionDe(res), parsear(esquemaBloqueo, req.body)));
  });

  rutas.delete('/:id', ...permisos.admin, async (req, res) => {
    const { id } = parsear(esquemaIdBloqueo, req.params);
    res.json(await bloqueos.borrar(sesionDe(res), id));
  });

  return rutas;
};
