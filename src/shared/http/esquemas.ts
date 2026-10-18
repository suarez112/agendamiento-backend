import { z } from 'zod';
import { esFechaReal } from '../../modules/citas/horas.js';

// Piezas de validación compartidas por los módulos de gestión del negocio

export const obligatorio = (campo: string) => `El campo "${campo}" es obligatorio`;

export const texto = (campo: string, max: number) =>
  z
    .string({ error: obligatorio(campo) })
    .trim()
    .min(1, obligatorio(campo))
    .max(max, `El campo "${campo}" admite máximo ${max} caracteres`);

// Texto opcional: vacío o null se guarda como NULL
export const textoOpcional = (campo: string, max: number) => {
  const mensaje = `El campo "${campo}" debe ser texto`;
  return z
    .union([z.string().trim().max(max, `El campo "${campo}" admite máximo ${max} caracteres`), z.null()], {
      error: mensaje,
    })
    .optional()
    .transform((valor) => (valor === '' ? null : valor));
};

// Identificador recibido en la URL (ej. /servicios/:id)
export const esquemaId = (mensaje: string) =>
  z.object({ id: z.string({ error: mensaje }).trim().min(1, mensaje).max(64, mensaje) });

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

export const hora = (campo: string) =>
  z.string({ error: obligatorio(campo) }).regex(HORA, `La ${campo} debe tener el formato HH:MM (24 horas)`);

export const fecha = (campo: string) =>
  z
    .string({ error: obligatorio(campo) })
    .refine(esFechaReal, `El campo "${campo}" debe ser una fecha real con el formato AAAA-MM-DD`);

// Precio en pesos: cero o más, con máximo dos decimales
export const precio = (campo: string) =>
  z
    .number({ error: `El ${campo} debe ser un número` })
    .min(0, `El ${campo} no puede ser negativo`)
    .max(100_000_000, `El ${campo} es demasiado alto`)
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, `El ${campo} admite máximo dos decimales`);

// Para ediciones parciales: al menos un campo debe venir
export const conAlMenosUnDato = <T extends z.ZodType<Record<string, unknown>>>(esquema: T) =>
  esquema.refine((d) => Object.values(d).some((v) => v !== undefined), {
    error: 'Envía al menos un dato para actualizar',
  });
