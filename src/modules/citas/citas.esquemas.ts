import { z } from 'zod';
import { conTelefonoNormalizado } from '../../shared/telefonos.js';
import { aceptacionOpcional } from '../legal/legal.js';
import { esFechaReal, hora12AMinutos } from './horas.js';

const FALTAN_DATOS = 'Faltan datos para agendar la cita';
const FORMATO_INCORRECTO = 'La fecha o la hora tienen un formato incorrecto';

const texto = (mensaje: string) => z.string({ error: mensaje }).trim().min(1, mensaje);
const identificador = (mensaje: string) => texto(mensaje).max(64, mensaje);

// Indicativo del país (solo dígitos). Si no llega, se asume Colombia (57)
export const esquemaIndicativo = z
  .union([z.string(), z.number()], { error: 'El indicativo del país no es válido' })
  .nullish()
  .transform((v) => String(v ?? '57').replace(/\D/g, ''))
  .refine((v) => /^\d{1,4}$/.test(v), 'El indicativo del país no es válido');

export const esquemaCrearCita = z.object(
  {
    empresaId: identificador(FALTAN_DATOS),
    barberoId: identificador(FALTAN_DATOS),
    servicioId: identificador(FALTAN_DATOS),
    fecha: texto(FALTAN_DATOS).refine(esFechaReal, FORMATO_INCORRECTO),
    hora: texto(FALTAN_DATOS).refine((h) => hora12AMinutos(h) !== null, FORMATO_INCORRECTO),
    // Obligatorios para el invitado. Un cliente con sesión usa los de su cuenta.
    nombre: texto(FALTAN_DATOS).max(100, 'El nombre es demasiado largo').optional(),
    // Se valida y se guarda en E.164 (ver shared/telefonos.ts)
    telefono: texto(FALTAN_DATOS).max(30, 'El teléfono no es válido').optional(),
    indicativo: esquemaIndicativo,
    // Política de Tratamiento de Datos y Términos y Condiciones
    ...aceptacionOpcional,
  },
  { error: FALTAN_DATOS },
).transform(conTelefonoNormalizado);

export type DatosNuevaCita = z.output<typeof esquemaCrearCita>;

export const esquemaHorasOcupadas = z.object({
  empresaId: identificador('Falta el identificador del negocio'),
});

// Horas disponibles de un profesional para un servicio en una fecha
export const esquemaHorasDisponibles = z.object({
  empresaId: identificador('Falta el identificador del negocio'),
  barberoId: identificador('Falta el identificador del profesional'),
  servicioId: identificador('Falta el identificador del servicio'),
  fecha: texto('Falta la fecha').refine(esFechaReal, 'La fecha debe tener el formato AAAA-MM-DD'),
});

export const esquemaIdCita = z.object({
  id: identificador('Identificador de cita inválido'),
});
