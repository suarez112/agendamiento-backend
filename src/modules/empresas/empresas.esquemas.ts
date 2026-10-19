import { z } from 'zod';
import { departamentoOficial, municipioOficial } from '../ubicaciones/ubicaciones.js';
import { esquemaHorario } from './horario.js';

// Perfil de la empresa: lo usan el registro y la edición del administrador.
// Los límites coinciden con las columnas y restricciones de las migraciones 003 y 007.

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

export const MENSAJE_CORREO = 'El correo no es válido';

export const esquemaCorreo = z
  .string({ error: obligatorio('correo') })
  .trim()
  .toLowerCase()
  .max(254, MENSAJE_CORREO)
  .pipe(z.email({ error: MENSAJE_CORREO }));

// Código que los clientes escriben para encontrar el negocio. Se guarda en
// mayúsculas, así "abc" y "ABC" son el mismo código.
export const MENSAJE_CODIGO =
  'El código del negocio solo puede tener letras (sin tildes ni ñ) y números, sin espacios, máximo 10 caracteres';

export const esquemaCodigoNegocio = z
  .string({ error: obligatorio('código del negocio') })
  .trim()
  .min(1, obligatorio('código del negocio'))
  .regex(/^[A-Za-z0-9]{1,10}$/, MENSAJE_CODIGO)
  .transform((codigo) => codigo.toUpperCase());

// Usuario de inicio de sesión de la administradora
export const MENSAJE_USUARIO = 'El usuario debe tener entre 4 y 20 caracteres: solo letras, números, punto y guion bajo';

export const esquemaUsuarioAdmin = z
  .string({ error: obligatorio('usuario') })
  .trim()
  .min(1, obligatorio('usuario'))
  .regex(/^[A-Za-z0-9._]{4,20}$/, MENSAJE_USUARIO);

const MENSAJE_EMPLEADOS = 'El número de empleados debe ser un número entero entre 1 y 10';

const perfil = {
  nombre: texto('nombre', 100),
  categoria: texto('categoría', 60),
  codigoAcceso: esquemaCodigoNegocio,
  direccion: texto('dirección', 200),
  departamento: texto('departamento', 60),
  ciudad: texto('ciudad', 100),
  horario: esquemaHorario,
  nombreAdministradora: texto('nombre de la administradora', 120),
  numeroEmpleados: z
    .number({ error: MENSAJE_EMPLEADOS })
    .int(MENSAJE_EMPLEADOS)
    .min(1, MENSAJE_EMPLEADOS)
    .max(10, MENSAJE_EMPLEADOS),
  // Solo direcciones web http(s); evita enlaces como javascript:
  logoUrl: opcional(
    z
      .string()
      .trim()
      .max(2048, 'La dirección del logo es demasiado larga')
      .regex(/^(https?:\/\/\S+)?$/, 'El logo debe ser una dirección web que empiece por http:// o https://'),
  ),
};

type ConUbicacion = { departamento?: string; ciudad?: string };

// El departamento debe ser de Colombia y la ciudad un municipio de ese departamento
// (lista DIVIPOLA del DANE). Se guardan con el nombre oficial.
export const conUbicacionValida = <T extends z.ZodType<ConUbicacion>>(esquema: T) =>
  esquema
    .superRefine((d, ctx) => {
      if (d.departamento === undefined && d.ciudad === undefined) return;
      if (d.departamento === undefined || d.ciudad === undefined) {
        ctx.addIssue({ code: 'custom', message: 'Envía el departamento y la ciudad juntos' });
      } else if (!departamentoOficial(d.departamento)) {
        ctx.addIssue({ code: 'custom', message: 'El departamento no es un departamento de Colombia' });
      } else if (!municipioOficial(d.departamento, d.ciudad)) {
        ctx.addIssue({ code: 'custom', message: 'La ciudad no es un municipio de ese departamento' });
      }
    })
    .transform((d) =>
      d.departamento === undefined || d.ciudad === undefined
        ? d
        : { ...d, departamento: departamentoOficial(d.departamento)!, ciudad: municipioOficial(d.departamento, d.ciudad)! },
    );

export const esquemaPerfilEmpresa = z.object(perfil, { error: 'Envía los datos de la empresa' });

// Coordenadas del negocio en el mapa (solo en "Mi negocio"). null las quita.
const coordenada = (campo: 'latitud' | 'longitud', limite: number) => {
  const mensaje = `La ${campo} debe ser un número entre -${limite} y ${limite}`;
  return z
    .union([z.number({ error: mensaje }).min(-limite, mensaje).max(limite, mensaje), z.null()], { error: mensaje })
    .optional();
};

const COORDENADAS_JUNTAS = 'Envía la latitud y la longitud juntas (o las dos en null para quitarlas)';

// Edición: todos los campos son opcionales, pero debe venir al menos uno.
// Campos como id, estado de la suscripción o fin de la prueba se ignoran.
export const esquemaActualizarEmpresa = conUbicacionValida(
  esquemaPerfilEmpresa
    .extend({ latitud: coordenada('latitud', 90), longitud: coordenada('longitud', 180) })
    .partial()
    .refine((d) => Object.values(d).some((v) => v !== undefined), {
      error: 'Envía al menos un dato para actualizar',
    })
    .refine((d) => (d.latitud === undefined) === (d.longitud === undefined) && (d.latitud === null) === (d.longitud === null), {
      error: COORDENADAS_JUNTAS,
    }),
);

export type PerfilEmpresa = z.output<typeof esquemaPerfilEmpresa>;
export type CambiosEmpresa = z.output<typeof esquemaActualizarEmpresa>;
