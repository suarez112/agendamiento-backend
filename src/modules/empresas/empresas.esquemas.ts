import { z } from 'zod';
import { INTERVALOS_MINUTOS } from '../citas/disponibilidad.js';
import { departamentoOficial, municipioOficial } from '../ubicaciones/ubicaciones.js';
import { esZonaValida, zonaCanonica } from '../../shared/zonaHoraria.js';
import { normalizarTelefono, TELEFONO_INVALIDO } from '../../shared/telefonos.js';
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
  // WhatsApp de contacto (opcional). Se valida y se guarda en E.164 (ver conWhatsappNormalizado).
  // Sin código de país se usa "indicativoWhatsapp" y, si tampoco llega, Colombia (57).
  whatsappContacto: z.union([z.string().trim().max(30, TELEFONO_INVALIDO), z.null()]).optional(),
  indicativoWhatsapp: z.union([z.string(), z.number()]).optional(),
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

type ConUbicacion = { departamento?: string; ciudad?: string; pais?: string };

// Zona horaria IANA del negocio (ej. America/Bogota); se guarda con su nombre oficial
export const MENSAJE_ZONA = 'La zona horaria no es válida. Usa un nombre como America/Bogota';

export const esquemaZonaHoraria = z
  .string({ error: MENSAJE_ZONA })
  .trim()
  .refine(esZonaValida, MENSAJE_ZONA)
  .transform(zonaCanonica);

// Con el país en Colombia, el departamento debe ser de Colombia y la ciudad un municipio de ese
// departamento (lista DIVIPOLA del DANE) y se guardan con el nombre oficial. Con otro país
// se guardan tal cual. Si no llega el país (edición), solo se exige enviar los dos juntos:
// el servicio la valida con el país del negocio (ver ubicacionOficial).
export const ubicacionOficial = (d: { departamento: string; ciudad: string }): string | { departamento: string; ciudad: string } => {
  if (!departamentoOficial(d.departamento)) return 'El departamento no es un departamento de Colombia';
  if (!municipioOficial(d.departamento, d.ciudad)) return 'La ciudad no es un municipio de ese departamento';
  return { departamento: departamentoOficial(d.departamento)!, ciudad: municipioOficial(d.departamento, d.ciudad)! };
};

export const conUbicacionValida = <T extends z.ZodType<ConUbicacion>>(esquema: T) =>
  esquema
    .superRefine((d, ctx) => {
      if (d.departamento === undefined && d.ciudad === undefined) return;
      if (d.departamento === undefined || d.ciudad === undefined) {
        ctx.addIssue({ code: 'custom', message: 'Envía el departamento y la ciudad juntos' });
      } else if (d.pais === 'CO') {
        const r = ubicacionOficial({ departamento: d.departamento, ciudad: d.ciudad });
        if (typeof r === 'string') ctx.addIssue({ code: 'custom', message: r });
      }
    })
    .transform((d) => {
      if (d.pais !== 'CO' || d.departamento === undefined || d.ciudad === undefined) return d;
      return { ...d, ...(ubicacionOficial({ departamento: d.departamento, ciudad: d.ciudad }) as object) };
    });

// Deja el WhatsApp de contacto en E.164 ('' o null = sin WhatsApp) o responde 400 si no es válido.
// Quita "indicativoWhatsapp": solo sirve para convertir el número.
export const conWhatsappNormalizado = <T extends z.ZodType<{ whatsappContacto?: string | null; indicativoWhatsapp?: string | number }>>(
  esquema: T,
) =>
  esquema.transform((d, ctx) => {
    const { indicativoWhatsapp, ...resto } = d;
    if (resto.whatsappContacto === undefined) return resto;
    if (resto.whatsappContacto === null || resto.whatsappContacto === '') return { ...resto, whatsappContacto: null };
    const indicativo = String(indicativoWhatsapp ?? '57').replace(/\D/g, '');
    const numero = /^\d{1,4}$/.test(indicativo) ? normalizarTelefono(resto.whatsappContacto, indicativo) : null;
    if (!numero) {
      ctx.addIssue({ code: 'custom', message: TELEFONO_INVALIDO, path: ['whatsappContacto'] });
      return z.NEVER;
    }
    return { ...resto, whatsappContacto: numero.telefono };
  });

export const esquemaPerfilEmpresa = z.object(perfil, { error: 'Envía los datos de la empresa' });

// Redondea a n decimales (el GPS del celular entrega muchos más)
const redondear = (decimales: number) => (n: number) => Number(n.toFixed(decimales));

// Coordenadas del negocio en el mapa (solo en "Mi negocio"), con hasta 6 decimales
// (≈ 11 cm): si llegan más, se redondean. null las quita.
const coordenada = (campo: 'latitud' | 'longitud', limite: number) => {
  const mensaje = `La ${campo} debe ser un número entre -${limite} y ${limite}`;
  return z
    .union([z.number({ error: mensaje }).min(-limite, mensaje).max(limite, mensaje).transform(redondear(6)), z.null()], {
      error: mensaje,
    })
    .optional();
};

// Precisión del GPS en metros (opcional), redondeada a un decimal
const MENSAJE_PRECISION = 'La precisión de la ubicación debe ser un número de metros mayor que 0 y hasta 100000';
const precisionUbicacion = z
  .union(
    [
      z.number({ error: MENSAJE_PRECISION }).gt(0, MENSAJE_PRECISION).max(100000, MENSAJE_PRECISION).transform(redondear(1)),
      z.null(),
    ],
    { error: MENSAJE_PRECISION },
  )
  .optional();

const MENSAJE_ANTICIPACION = 'La anticipación para cancelar o reprogramar debe ser un número entero de horas entre 0 y 48';

const COORDENADAS_JUNTAS = 'Envía la latitud y la longitud juntas (o las dos en null para quitarlas)';
const PRECISION_CON_COORDENADAS = 'Envía la precisión de la ubicación junto con la latitud y la longitud';

// Edición: todos los campos son opcionales, pero debe venir al menos uno.
// Campos como id, estado de la suscripción o fin de la prueba se ignoran.
export const esquemaActualizarEmpresa = conWhatsappNormalizado(conUbicacionValida(
  esquemaPerfilEmpresa
    .extend({
      anticipacionCancelacionHoras: z
        .number({ error: MENSAJE_ANTICIPACION })
        .int(MENSAJE_ANTICIPACION)
        .min(0, MENSAJE_ANTICIPACION)
        .max(48, MENSAJE_ANTICIPACION),
      latitud: coordenada('latitud', 90),
      longitud: coordenada('longitud', 180),
      precisionUbicacion,
      zonaHoraria: esquemaZonaHoraria,
    })
    .partial()
    .refine((d) => Object.values(d).some((v) => v !== undefined), {
      error: 'Envía al menos un dato para actualizar',
    })
    .refine((d) => (d.latitud === undefined) === (d.longitud === undefined) && (d.latitud === null) === (d.longitud === null), {
      error: COORDENADAS_JUNTAS,
    })
    .refine((d) => d.precisionUbicacion == null || (d.latitud != null && d.longitud != null), {
      error: PRECISION_CON_COORDENADAS,
    })
    // Coordenadas nuevas sin precisión: la anterior ya no aplica y se borra
    .transform((d) =>
      d.latitud === undefined ? d : { ...d, precisionUbicacion: d.latitud === null ? null : (d.precisionUbicacion ?? null) },
    ),
));

export type PerfilEmpresa = z.output<typeof esquemaPerfilEmpresa>;
export type CambiosEmpresa = z.output<typeof esquemaActualizarEmpresa>;

const MENSAJE_INTERVALO = `El intervalo debe ser ${INTERVALOS_MINUTOS.join(', ')} minutos`;

// Cada cuántos minutos pueden agendar los clientes
export const esquemaIntervalo = z.object(
  {
    intervaloMinutos: z
      .number({ error: MENSAJE_INTERVALO })
      .refine((m) => INTERVALOS_MINUTOS.includes(m), MENSAJE_INTERVALO),
  },
  { error: 'Envía el intervalo en "intervaloMinutos"' },
);
