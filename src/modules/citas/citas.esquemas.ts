import { z } from 'zod';
import { esFechaReal, hora12AMinutos } from './horas.js';

const FALTAN_DATOS = 'Faltan datos para agendar la cita';
const FORMATO_INCORRECTO = 'La fecha o la hora tienen un formato incorrecto';

const texto = (mensaje: string) => z.string({ error: mensaje }).trim().min(1, mensaje);
const identificador = (mensaje: string) => texto(mensaje).max(64, mensaje);

export const esquemaCrearCita = z.object(
  {
    empresaId: identificador(FALTAN_DATOS),
    barberoId: identificador(FALTAN_DATOS),
    servicioId: identificador(FALTAN_DATOS),
    fecha: texto(FALTAN_DATOS).refine(esFechaReal, FORMATO_INCORRECTO),
    hora: texto(FALTAN_DATOS).refine((h) => hora12AMinutos(h) !== null, FORMATO_INCORRECTO),
    nombre: texto(FALTAN_DATOS).max(100, 'El nombre es demasiado largo'),
    telefono: texto(FALTAN_DATOS).regex(/^[0-9 ().+-]{5,20}$/, 'El teléfono no es válido'),
    // Indicativo del país (solo dígitos). Si no llega, se asume Colombia (57)
    indicativo: z
      .union([z.string(), z.number()], { error: 'El indicativo del país no es válido' })
      .optional()
      .transform((v) => String(v ?? '57').replace(/\D/g, ''))
      .refine((v) => /^\d{1,4}$/.test(v), 'El indicativo del país no es válido'),
  },
  { error: FALTAN_DATOS },
);

export type DatosNuevaCita = z.output<typeof esquemaCrearCita>;

export const esquemaHorasOcupadas = z.object({
  empresaId: identificador('Falta el identificador del negocio'),
});

export const esquemaIdCita = z.object({
  id: identificador('Identificador de cita inválido'),
});
