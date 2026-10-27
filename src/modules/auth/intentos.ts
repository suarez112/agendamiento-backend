import { createHash } from 'node:crypto';
import type pg from 'pg';
import { enTransaccion } from '../../db/pool.js';
import { ErrorApp, errores } from '../../shared/errores.js';
import { registro } from '../../shared/registro.js';

// Contador de inicios de sesión fallidos por cuenta, guardado en la tabla intentos_login (migración 029):
// sobrevive a un reinicio del servidor y vale para todas las instancias. Se suma al límite por IP
// (shared/http/limitadores.ts), que no frena a quien prueba contraseñas desde muchas IP.
//
// - La clave es un hash del correo o usuario (nunca el texto) y se cuenta también para identificadores que no
//   existen: la respuesta no revela qué cuentas hay.
// - Tras `max` fallos seguidos dentro de la ventana, la cuenta se bloquea un rato; cada bloqueo seguido dura el
//   doble (con tope), y se reinicia con un inicio de sesión correcto o tras un día sin intentos.
// - Mientras está bloqueada se rechaza también la contraseña correcta (si no, el bloqueo no frenaría nada).
//   Quien olvidó su contraseña puede recuperarla por correo.

export type ConfigIntentos = {
  max: number;
  ventanaMs: number;
  bloqueoBaseMs: number;
  bloqueoMaxMs: number;
};

const UN_DIA_MS = 24 * 60 * 60_000;

export const MENSAJE_BLOQUEO_LOGIN = 'Demasiados intentos de inicio de sesión. Intenta de nuevo en unos minutos.';

type FilaIntentos = {
  intentos: number;
  primer_intento: Date;
  bloqueos: number;
  bloqueado_hasta: Date | null;
  actualizado_en: Date;
  ahora: Date;
};

export const crearServicioIntentos = (pool: pg.Pool, config: ConfigIntentos) => ({
  // Clave de la cuenta: un hash corto, para no guardar correos ni usuarios
  claveDe: (ambito: string, identificador: string) =>
    `${ambito}:${createHash('sha256').update(identificador.trim().toLowerCase()).digest('hex')}`,

  // Lanza 429 si la cuenta está bloqueada
  async exigirSinBloqueo(clave: string) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM intentos_login WHERE clave = $1 AND bloqueado_hasta > now()',
      [clave],
    );
    if (rowCount) throw errores.demasiadosIntentos(MENSAJE_BLOQUEO_LOGIN);
  },

  // Suma un fallo; al llegar al máximo bloquea la cuenta. Devuelve los fallos seguidos que lleva.
  async registrarFallo(clave: string): Promise<number> {
    return await enTransaccion(pool, async (tx) => {
      await tx.query('INSERT INTO intentos_login (clave) VALUES ($1) ON CONFLICT (clave) DO NOTHING', [clave]);
      const f = (
        await tx.query<FilaIntentos>(
          `SELECT intentos, primer_intento, bloqueos, bloqueado_hasta, actualizado_en, now() AS ahora
           FROM intentos_login WHERE clave = $1 FOR UPDATE`,
          [clave],
        )
      ).rows[0];
      const ahora = f.ahora.getTime();
      // Bloqueada: el fallo no cambia nada (el bloqueo ya está corriendo)
      if (f.bloqueado_hasta && f.bloqueado_hasta.getTime() > ahora) return f.intentos;

      let { intentos, primer_intento: primero, bloqueos } = f;
      // Una ventana nueva empieza de cero; tras un día sin intentos también se olvidan los bloqueos
      if (ahora - primero.getTime() > config.ventanaMs) {
        intentos = 0;
        primero = f.ahora;
      }
      if (ahora - f.actualizado_en.getTime() > UN_DIA_MS) bloqueos = 0;

      intentos += 1;
      let bloqueadoHasta: Date | null = null;
      if (intentos >= config.max) {
        bloqueos += 1;
        const espera = Math.min(config.bloqueoBaseMs * 2 ** (bloqueos - 1), config.bloqueoMaxMs);
        bloqueadoHasta = new Date(ahora + espera);
        intentos = 0;
        primero = f.ahora;
      }
      await tx.query(
        `UPDATE intentos_login
         SET intentos = $2, primer_intento = $3, bloqueos = $4, bloqueado_hasta = $5, actualizado_en = now()
         WHERE clave = $1`,
        [clave, intentos, primero, bloqueos, bloqueadoHasta],
      );
      // Limpieza: las filas sin actividad desde hace un día y sin bloqueo vigente ya no sirven
      await tx.query(
        `DELETE FROM intentos_login
         WHERE actualizado_en < now() - interval '1 day' AND (bloqueado_hasta IS NULL OR bloqueado_hasta < now())`,
      );
      return bloqueadoHasta ? config.max : intentos;
    });
  },

  // Inicio de sesión correcto: la cuenta empieza de cero
  async limpiar(clave: string) {
    await pool.query('DELETE FROM intentos_login WHERE clave = $1', [clave]);
  },
});

export type ServicioIntentos = ReturnType<typeof crearServicioIntentos>;

export type OrigenLogin = { ruta: string; ip: string | null };

// Envuelve un inicio de sesión con el contador de la cuenta:
// 1. Si la cuenta está bloqueada, responde 429 sin siquiera probar la contraseña.
// 2. Un 401 (credenciales incorrectas) suma un fallo y queda en el registro del servidor (sin contraseña ni
//    correo: solo la ruta, la IP y un hash corto de la cuenta, para detectar un ataque).
// 3. Un inicio correcto reinicia el contador.
export const conContadorDeCuenta = async <T>(
  intentos: ServicioIntentos,
  clave: string,
  origen: OrigenLogin,
  intento: () => Promise<T>,
  evento = 'login_fallido',
): Promise<T> => {
  await intentos.exigirSinBloqueo(clave);
  try {
    const resultado = await intento();
    await intentos.limpiar(clave);
    return resultado;
  } catch (error) {
    if (error instanceof ErrorApp && error.estado === 401) {
      const fallos = await intentos.registrarFallo(clave).catch((e: Error) => {
        // Un fallo del contador no debe cambiar la respuesta de login
        registro.error('intentos_login_fallo', { mensaje: e.message });
        return null;
      });
      registro.warn(evento, { ruta: origen.ruta, ip: origen.ip, cuenta: clave.slice(-12), fallosSeguidos: fallos });
    }
    throw error;
  }
};
