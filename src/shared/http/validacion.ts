import type { z } from 'zod';
import { errores } from '../errores.js';

// Valida y convierte datos de entrada con un esquema zod. Si no cumplen,
// responde 400 con el mensaje del primer problema encontrado.
export const parsear = <T extends z.ZodType>(esquema: T, datos: unknown): z.output<T> => {
  const resultado = esquema.safeParse(datos);
  if (!resultado.success) {
    throw errores.solicitudInvalida(resultado.error.issues[0]?.message ?? 'Datos inválidos');
  }
  return resultado.data;
};
