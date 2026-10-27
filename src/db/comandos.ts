import { createInterface } from 'node:readline/promises';
import type { Consultable } from './pool.js';

// Piezas comunes de los comandos de consola (npm run dev:* y db:*). Son comandos de quien tiene acceso al
// servidor, no endpoints, así que dos reglas los acompañan (hallazgo B-6):
// 1. Los que cambian dinero, accesos o datos se niegan con NODE_ENV=production (salvo dev:activar-plan, que sirve
//    para activar a mano un negocio mientras no haya pasarela de pagos y pide confirmación).
// 2. Todo comando que cambia algo deja una fila en actividad_superadmin (solo inserción), con un "usuario" de
//    sistema (comando:<nombre>), para que quede quién y cuándo, igual que las acciones del panel.
//
// Ojo: NODE_ENV lo define quien ejecuta el comando; esto es un cinturón de seguridad contra errores, no un candado
// contra quien ya controla el servidor y su .env.

export const enProduccion = (env: NodeJS.ProcessEnv = process.env) => env.NODE_ENV === 'production';

// Texto del rechazo, o null si el comando puede correr
export const motivoDeNegacion = (nombre: string, env: NodeJS.ProcessEnv = process.env) =>
  enProduccion(env)
    ? `✖ ${nombre} no se ejecuta con NODE_ENV=production: cambia dinero, accesos o datos reales. ` +
      'Si de verdad hace falta, ejecútalo desde una máquina de confianza apuntando a esa base, con NODE_ENV=development.'
    : null;

// Termina el proceso con un mensaje si el comando está prohibido en este entorno
export const negarEnProduccion = (nombre: string) => {
  const motivo = motivoDeNegacion(nombre);
  if (motivo) {
    console.error(motivo);
    process.exit(1);
  }
};

// Pregunta con (s/N); solo "s", "si" o "sí" confirman. Cualquier otra cosa, o no haber quien responda, cancela.
export const confirmar = async (pregunta: string, entrada: NodeJS.ReadableStream = process.stdin): Promise<boolean> => {
  const consola = createInterface({ input: entrada, output: process.stdout });
  try {
    // Si la entrada termina sin respuesta (nadie escribe, o se cierra la terminal), cuenta como un no
    const respuesta = await new Promise<string>((resolver) => {
      // Se deja pasar un instante: la respuesta y el cierre de la entrada pueden llegar juntos, y la respuesta gana
      consola.once('close', () => setImmediate(() => resolver('')));
      consola.question(`${pregunta} (s/N) `).then(resolver, () => resolver(''));
    });
    const texto = respuesta.trim().toLowerCase();
    return texto === 's' || texto === 'si' || texto === 'sí';
  } finally {
    consola.close();
  }
};

export type RegistroDeComando = {
  // Nombre del comando, ej. "dev:activar-plan"
  comando: string;
  // Qué hizo, ej. "activar_plan" (se guarda como "cmd_activar_plan", máximo 40 caracteres)
  accion: string;
  empresa?: { id: string; codigo_acceso: string; nombre: string };
  referencia?: string;
  detalle?: Record<string, unknown>;
};

export const SUPERADMIN_DE_SISTEMA = 'sistema';

// Anota en actividad_superadmin que se ejecutó un comando. Los datos personales no van aquí: solo qué se hizo.
export const registrarComando = async (db: Consultable, c: RegistroDeComando) => {
  await db.query(
    `INSERT INTO actividad_superadmin
       (superadmin_id, superadmin_correo, accion, empresa_id, empresa_codigo, empresa_nombre, referencia, detalle)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      SUPERADMIN_DE_SISTEMA,
      `comando:${c.comando}`,
      `cmd_${c.accion}`.slice(0, 40),
      c.empresa?.id ?? null,
      c.empresa?.codigo_acceso ?? null,
      c.empresa?.nombre ?? null,
      c.referencia?.slice(0, 40) ?? null,
      JSON.stringify(c.detalle ?? {}),
    ],
  );
};
