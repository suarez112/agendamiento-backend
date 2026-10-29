import { z } from 'zod';
import { MAX_CITAS_PENDIENTES_POR_TELEFONO } from './reservas.js';

// Variables de entorno validadas una sola vez al arrancar: si falta algo, el
// servidor no inicia y dice qué variable revisar (sin mostrar su valor).

const esquemaBaseDeDatos = z.object({
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USER: z.string().trim().min(1),
  // Nunca se acepta vacía: una contraseña que falta no debe pasar por una sin contraseña
  DB_PASSWORD: z
    .string({ error: 'falta: escribe la contraseña del usuario de la base de datos' })
    .min(1, 'está vacía: escribe la contraseña del usuario de la base de datos')
    .refine((v) => v.trim() !== '', 'está vacía: escribe la contraseña del usuario de la base de datos'),
  DB_NAME: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
});

const LLAVES_WOMPI = {
  WOMPI_LLAVE_PUBLICA: { produccion: 'pub_prod_', prueba: 'pub_test_' },
  WOMPI_LLAVE_PRIVADA: { produccion: 'prv_prod_', prueba: 'prv_test_' },
  WOMPI_SECRETO_EVENTOS: { produccion: 'prod_events_', prueba: 'test_events_' },
  WOMPI_SECRETO_INTEGRIDAD: { produccion: 'prod_integrity_', prueba: 'test_integrity_' },
} as const;

// Proveedor de pago que queda activo: el elegido, o "simulado" fuera de producción. undefined = pagos desactivados.
export const proveedorDePagoActivo = (e: { NODE_ENV: string; PROVEEDOR_PAGO?: 'simulado' | 'wompi' }) =>
  e.PROVEEDOR_PAGO ?? (e.NODE_ENV === 'production' ? undefined : 'simulado');

// ¿El proveedor activo cobra en modo de prueba? (simulado, o Wompi con la llave pública de prueba)
export const proveedorDePagoEsDePrueba = (e: { NODE_ENV: string; PROVEEDOR_PAGO?: 'simulado' | 'wompi'; WOMPI_LLAVE_PUBLICA?: string }) => {
  const activo = proveedorDePagoActivo(e);
  return activo === 'simulado' || (activo === 'wompi' && Boolean(e.WOMPI_LLAVE_PUBLICA?.startsWith(LLAVES_WOMPI.WOMPI_LLAVE_PUBLICA.prueba)));
};

// El servidor se niega a arrancar en producción con el proveedor simulado o con llaves de prueba, y con Wompi
// exige las cuatro llaves (en producción, con el prefijo de producción) y URL_PAGOS.
const revisarPagos = (
  e: {
    NODE_ENV: string;
    PROVEEDOR_PAGO?: 'simulado' | 'wompi';
    URL_PAGOS?: string;
  } & Partial<Record<keyof typeof LLAVES_WOMPI, string>>,
  ctx: z.RefinementCtx,
) => {
  const produccion = e.NODE_ENV === 'production';
  const problema = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (produccion && e.PROVEEDOR_PAGO === 'simulado') {
    problema('PROVEEDOR_PAGO', 'el proveedor simulado no puede usarse en producción: usa wompi (con llaves de producción) o quita la variable');
  }
  for (const [nombre, prefijos] of Object.entries(LLAVES_WOMPI) as [keyof typeof LLAVES_WOMPI, (typeof LLAVES_WOMPI)[keyof typeof LLAVES_WOMPI]][]) {
    const valor = e[nombre];
    // Una llave de prueba en producción impide arrancar aunque el proveedor no sea wompi: no debe estar ahí
    if (produccion && valor && valor.startsWith(prefijos.prueba)) {
      problema(nombre, 'es una llave de prueba (sandbox) y no puede usarse en producción');
    }
  }
  if (e.PROVEEDOR_PAGO !== 'wompi') return;
  for (const [nombre, prefijos] of Object.entries(LLAVES_WOMPI) as [keyof typeof LLAVES_WOMPI, (typeof LLAVES_WOMPI)[keyof typeof LLAVES_WOMPI]][]) {
    const valor = e[nombre];
    if (!valor) problema(nombre, 'falta: es obligatoria con PROVEEDOR_PAGO=wompi (ver .env.example)');
    else if (produccion && !valor.startsWith(prefijos.produccion)) {
      problema(nombre, `en producción debe ser una llave de producción (empieza con ${prefijos.produccion})`);
    }
  }
  if (produccion && !e.URL_PAGOS) problema('URL_PAGOS', 'falta: es obligatoria en producción con PROVEEDOR_PAGO=wompi');
};

const esquemaEntorno = esquemaBaseDeDatos
  .extend({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().nonnegative().default(4000),
    // Tres secretos independientes (hallazgo B-4): si uno se filtra, no compromete los otros dos.
    // - JWT_SECRET: firma las sesiones. Cambiarlo cierra todas las sesiones abiertas.
    // - RECUPERACION_SECRET: protege los códigos para recuperar la contraseña (cambiarlo invalida los códigos pendientes).
    // - TOTP_SECRET: cifra la clave de la verificación en dos pasos del superadmin (cambiarlo exige volver a
    //   cifrarla con npm run db:recifrar-2fa, o el superadmin no podría entrar).
    // Los tres son obligatorios, distintos entre sí, y los dos nuevos de al menos 32 caracteres.
    JWT_SECRET: z.string().min(16, 'debe tener al menos 16 caracteres'),
    RECUPERACION_SECRET: z.string({ error: 'falta: genera un secreto propio (ver .env.example)' }).min(32, 'debe tener al menos 32 caracteres'),
    TOTP_SECRET: z.string({ error: 'falta: genera un secreto propio (ver .env.example)' }).min(32, 'debe tener al menos 32 caracteres'),
    JWT_EXPIRA_EN: z
      .string()
      .regex(/^\d+[smhd]$/, 'usa un formato como 12h o 30m')
      .default('12h'),
    // Orígenes web permitidos, separados por comas. Las apps nativas no envían Origin.
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((lista) => lista.split(',').map((o) => o.trim()).filter(Boolean)),
    // Número de proxies de confianza delante del servidor. Por defecto 0 = conexión directa: se ignoran
    // X-Forwarded-For y CF-Connecting-IP, que cualquiera puede escribir. Afecta la IP de los límites de
    // solicitudes y la de la prueba de las autorizaciones. Un número mayor al real deja que un atacante invente su IP;
    // uno menor hace que todos parezcan venir del proxy. Ver docs/despliegue/trust-proxy.md.
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
    // true solo si el servidor está detrás de Cloudflare: entonces se confía en CF-Connecting-IP.
    // Requiere TRUST_PROXY mayor que 0.
    DETRAS_DE_CLOUDFLARE: z
      .enum(['true', 'false'], { error: 'debe ser true o false' })
      .default('false')
      .transform((v) => v === 'true'),
    // Máximo de citas pendientes por teléfono en cada negocio (frena las reservas falsas)
    MAX_CITAS_PENDIENTES: z.coerce.number().int().min(1).max(50).default(MAX_CITAS_PENDIENTES_POR_TELEFONO),
    // Carpeta donde se guardan las fotos subidas (relativa a donde arranca el servidor)
    CARPETA_SUBIDAS: z.string().min(1).default('uploads'),
    // Dirección pública del servidor para armar las URL de las fotos
    // (ej. https://api.mibarberia.co). Si falta, se usa la de cada solicitud.
    URL_PUBLICA: z
      .url({ protocol: /^https?$/, error: 'debe ser una dirección http:// o https://' })
      .transform((url) => url.replace(/\/+$/, ''))
      .optional(),
    // Dirección base de los enlaces públicos de los negocios (ej. agendaya.app). El enlace de
    // cada negocio es <base>/<CÓDIGO>. Sin protocolo se asume https://.
    ENLACE_PUBLICO_BASE: z
      .string()
      .trim()
      .min(1)
      .regex(/^(https?:\/\/)?[A-Za-z0-9.-]+(:\d+)?(\/[^\s?#]*)?$/, 'debe ser una dirección como agendaya.app')
      .default('agendaya.app')
      .transform((base) => (/^https?:\/\//.test(base) ? base : `https://${base}`).replace(/\/+$/, '')),
    // Token de acceso de Expo para enviar notificaciones push (opcional: sin él también funciona)
    EXPO_ACCESS_TOKEN: z.string().min(1).optional(),
    // Pagos de la suscripción. PROVEEDOR_PAGO: "simulado" (solo desarrollo; es el valor por defecto fuera de
    // producción) o "wompi". En producción no hay valor por defecto y "simulado" impide arrancar: sin
    // PROVEEDOR_PAGO los pagos en línea quedan desactivados (la activación sigue siendo manual).
    PROVEEDOR_PAGO: z.enum(['simulado', 'wompi'], { error: 'debe ser simulado o wompi' }).optional(),
    // A dónde vuelve la persona después de pagar (la app o su página web): se le agrega /<referencia>
    URL_PAGOS: z
      .url({ protocol: /^https?$/, error: 'debe ser una dirección http:// o https://' })
      .transform((url) => url.replace(/\/+$/, ''))
      .optional(),
    // Llaves de Wompi (solo con PROVEEDOR_PAGO=wompi): publica, privada, secreto de eventos y secreto de integridad
    WOMPI_LLAVE_PUBLICA: z.string().trim().min(1).optional(),
    WOMPI_LLAVE_PRIVADA: z.string().trim().min(1).optional(),
    WOMPI_SECRETO_EVENTOS: z.string().trim().min(1).optional(),
    WOMPI_SECRETO_INTEGRIDAD: z.string().trim().min(1).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.DETRAS_DE_CLOUDFLARE && e.TRUST_PROXY === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['DETRAS_DE_CLOUDFLARE'],
        message: 'requiere TRUST_PROXY mayor que 0 (el número de proxies de confianza, Cloudflare incluido)',
      });
    }
    if (e.NODE_ENV === 'production' && e.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'en producción debe tener al menos 32 caracteres',
      });
    }
    for (const nombre of ['RECUPERACION_SECRET', 'TOTP_SECRET'] as const) {
      if (e[nombre] === e.JWT_SECRET) {
        ctx.addIssue({ code: 'custom', path: [nombre], message: 'debe ser distinto de JWT_SECRET: cada uso necesita su propio secreto' });
      }
    }
    revisarPagos(e, ctx);
    if (e.RECUPERACION_SECRET === e.TOTP_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['TOTP_SECRET'], message: 'debe ser distinto de RECUPERACION_SECRET' });
    }
  });

export type EntornoBaseDeDatos = z.infer<typeof esquemaBaseDeDatos>;
export type Entorno = z.infer<typeof esquemaEntorno>;

const leer = <T>(esquema: z.ZodType<T>, fuente: NodeJS.ProcessEnv): T => {
  const resultado = esquema.safeParse(fuente);
  if (resultado.success) return resultado.data;
  const detalle = resultado.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Configuración inválida en las variables de entorno:\n${detalle}`);
};

export const cargarEntorno = (fuente: NodeJS.ProcessEnv = process.env): Entorno =>
  leer(esquemaEntorno, fuente);

export const cargarEntornoBaseDeDatos = (
  fuente: NodeJS.ProcessEnv = process.env,
): EntornoBaseDeDatos => leer(esquemaBaseDeDatos, fuente);

// Las migraciones cambian la estructura, así que usan otro usuario (DB_MIGRACION_USER y
// DB_MIGRACION_PASSWORD) con más permisos que el de la app (DB_USER). Si no se definen,
// se usa DB_USER, como antes de separarlos.
export const cargarEntornoMigraciones = (
  fuente: NodeJS.ProcessEnv = process.env,
): EntornoBaseDeDatos => {
  const base = cargarEntornoBaseDeDatos(fuente);
  const usuario = fuente.DB_MIGRACION_USER?.trim();
  if (!usuario) return base;
  // Con usuario propio, su contraseña es obligatoria: nunca se prueba la de la app ni una vacía
  if (!fuente.DB_MIGRACION_PASSWORD?.trim()) {
    throw new Error(
      'Configuración inválida en las variables de entorno:\n' +
        '  - DB_MIGRACION_PASSWORD: falta o está vacía; es obligatoria cuando se define DB_MIGRACION_USER',
    );
  }
  return { ...base, DB_USER: usuario, DB_PASSWORD: fuente.DB_MIGRACION_PASSWORD };
};
