import { z } from 'zod';

// Perfil de la empresa: lo usan el registro y la edición del administrador.
// Los límites coinciden con las columnas y restricciones de la migración 003.

const obligatorio = (campo: string) => `El campo "${campo}" es obligatorio`;

const texto = (campo: string, max: number) =>
  z
    .string({ error: obligatorio(campo) })
    .trim()
    .min(1, obligatorio(campo))
    .max(max, `El campo "${campo}" admite máximo ${max} caracteres`);

// Texto opcional: vacío o null se guarda como NULL
const opcional = (esquema: z.ZodType<string>) =>
  z.union([esquema, z.null()]).optional().transform((valor) => (valor === '' ? null : valor));

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

const hora = (campo: string) =>
  z
    .string({ error: obligatorio(campo) })
    .regex(HORA, `La ${campo} debe tener el formato HH:MM (24 horas)`);

export const MENSAJE_CORREO = 'El correo no es válido';

export const esquemaCorreo = z
  .string({ error: obligatorio('correo') })
  .trim()
  .toLowerCase()
  .max(254, MENSAJE_CORREO)
  .pipe(z.email({ error: MENSAJE_CORREO }));

const MENSAJE_EMPLEADOS = 'El número de empleados debe ser un número entero mayor que cero';
const MENSAJE_DIAS = 'Los días de atención deben ser números del 0 (domingo) al 6 (sábado)';

const perfil = {
  nombre: texto('nombre', 100),
  categoria: texto('categoría', 60),
  // El NIT es opcional; la base le quita espacios y guiones
  nit: opcional(
    z
      .string()
      .trim()
      .max(20, 'El NIT admite máximo 20 caracteres')
      .regex(/^[0-9\s-]*$/, 'El NIT solo puede tener números, espacios y guiones'),
  ),
  telefono: texto('teléfono', 20)
    .min(7, 'El teléfono debe tener entre 7 y 20 caracteres')
    .regex(/^\+?[0-9\s()-]+$/, 'El teléfono solo puede tener números, espacios, paréntesis, guiones y +'),
  correo: esquemaCorreo,
  direccion: texto('dirección', 200),
  ciudad: texto('ciudad', 100),
  diasAtencion: z
    .array(z.number({ error: MENSAJE_DIAS }).int(MENSAJE_DIAS).min(0, MENSAJE_DIAS).max(6, MENSAJE_DIAS), {
      error: obligatorio('días de atención'),
    })
    .min(1, 'Elige al menos un día de atención')
    .max(7, 'Los días de atención no pueden repetirse')
    .refine((dias) => new Set(dias).size === dias.length, 'Los días de atención no pueden repetirse'),
  horarioApertura: hora('hora de apertura'),
  horarioCierre: hora('hora de cierre'),
  nombreAdministradora: texto('nombre de la administradora', 120),
  numeroEmpleados: z
    .number({ error: MENSAJE_EMPLEADOS })
    .int(MENSAJE_EMPLEADOS)
    .positive(MENSAJE_EMPLEADOS)
    .max(10_000, 'El número de empleados no puede ser mayor que 10000'),
  // Solo direcciones web http(s); evita enlaces como javascript:
  logoUrl: opcional(
    z
      .string()
      .trim()
      .max(2048, 'La dirección del logo es demasiado larga')
      .regex(/^(https?:\/\/\S+)?$/, 'El logo debe ser una dirección web que empiece por http:// o https://'),
  ),
};

export const MENSAJE_HORARIO = 'La hora de cierre debe ser posterior a la hora de apertura';

// "HH:MM" se compara bien como texto
const cierreDespuesDeApertura = (d: { horarioApertura?: string; horarioCierre?: string }) =>
  !d.horarioApertura || !d.horarioCierre || d.horarioCierre > d.horarioApertura;

export const esquemaPerfilEmpresa = z.object(perfil, { error: 'Envía los datos de la empresa' });

export const conHorarioValido = <T extends z.ZodType<{ horarioApertura?: string; horarioCierre?: string }>>(
  esquema: T,
) => esquema.refine(cierreDespuesDeApertura, { error: MENSAJE_HORARIO });

// Edición: todos los campos son opcionales, pero debe venir al menos uno.
// Campos como id, estado de la suscripción o fin de la prueba se ignoran.
export const esquemaActualizarEmpresa = conHorarioValido(
  esquemaPerfilEmpresa
    .partial()
    .refine((d) => Object.values(d).some((v) => v !== undefined), {
      error: 'Envía al menos un dato para actualizar',
    }),
);

export type PerfilEmpresa = z.output<typeof esquemaPerfilEmpresa>;
export type CambiosEmpresa = z.output<typeof esquemaActualizarEmpresa>;
