import { z } from 'zod';

// Variables de entorno validadas una sola vez al arrancar: si falta algo, el
// servidor no inicia y dice qué variable revisar (sin mostrar su valor).

const esquemaBaseDeDatos = z.object({
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
});

const esquemaEntorno = esquemaBaseDeDatos
  .extend({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().nonnegative().default(4000),
    JWT_SECRET: z.string().min(16, 'debe tener al menos 16 caracteres'),
    JWT_EXPIRA_EN: z
      .string()
      .regex(/^\d+[smhd]$/, 'usa un formato como 12h o 30m')
      .default('12h'),
    // Orígenes web permitidos, separados por comas. Las apps nativas no envían Origin.
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((lista) => lista.split(',').map((o) => o.trim()).filter(Boolean)),
    // Número de proxies delante del servidor (0 = conexión directa). Afecta la IP
    // que usa la limitación de solicitudes.
    TRUST_PROXY: z.coerce.number().int().nonnegative().default(0),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === 'production' && e.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'en producción debe tener al menos 32 caracteres',
      });
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
