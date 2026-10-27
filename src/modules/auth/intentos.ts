import { createHash } from 'node:crypto';
import type pg from 'pg';
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

export const MENSAJE_BLOQUEO_LOGIN = 'Demasiados intentos de inicio de sesión. Intenta de nuevo en unos minutos.';

// Suma un fallo en UNA sola sentencia: la base bloquea la fila, así que varios fallos a la vez se cuentan uno tras
// otro sin perder ninguno (si se leyera y se escribiera aparte, dos fallos simultáneos podrían contarse como uno).
// Todo se calcula con los valores de la fila ya bloqueada:
// - una ventana nueva empieza de cero; tras un día sin intentos también se olvidan los bloqueos;
// - al llegar al máximo se bloquea, y cada bloqueo seguido dura el doble (con tope);
// - si la cuenta ya está bloqueada no se cambia nada (el WHERE no deja actualizar y no se devuelve fila).
const VENTANA_VENCIDA = "(now() - intentos_login.primer_intento > $3::bigint * interval '1 millisecond')";
const INTENTOS_NUEVOS = `(CASE WHEN ${VENTANA_VENCIDA} THEN 0 ELSE intentos_login.intentos END + 1)`;
const BLOQUEOS_PREVIOS = "(CASE WHEN now() - intentos_login.actualizado_en > interval '1 day' THEN 0 ELSE intentos_login.bloqueos END)";
const BLOQUEA = `(${INTENTOS_NUEVOS} >= $2::int)`;
const SUMAR_FALLO = `
  INSERT INTO intentos_login (clave, intentos, bloqueos, bloqueado_hasta)
  VALUES (
    $1,
    CASE WHEN $2::int <= 1 THEN 0 ELSE 1 END,
    CASE WHEN $2::int <= 1 THEN 1 ELSE 0 END,
    CASE WHEN $2::int <= 1 THEN now() + $4::bigint * interval '1 millisecond' END
  )
  ON CONFLICT (clave) DO UPDATE SET
    intentos = CASE WHEN ${BLOQUEA} THEN 0 ELSE ${INTENTOS_NUEVOS} END,
    primer_intento = CASE WHEN ${BLOQUEA} OR ${VENTANA_VENCIDA} THEN now() ELSE intentos_login.primer_intento END,
    bloqueos = CASE WHEN ${BLOQUEA} THEN ${BLOQUEOS_PREVIOS} + 1 ELSE ${BLOQUEOS_PREVIOS} END,
    bloqueado_hasta = CASE WHEN ${BLOQUEA}
      THEN now() + LEAST($4::float8 * power(2::float8, ${BLOQUEOS_PREVIOS}), $5::float8) * interval '1 millisecond'
    END,
    actualizado_en = now()
  WHERE intentos_login.bloqueado_hasta IS NULL OR intentos_login.bloqueado_hasta <= now()
  RETURNING intentos, bloqueado_hasta`;

// Las filas sin actividad desde hace un día y sin bloqueo vigente ya no sirven. Va aparte del fallo y salta las
// filas que otro está usando, para que la limpieza nunca haga esperar un inicio de sesión. Si falla, no importa.
const purgar = async (pool: pg.Pool) => {
  await pool
    .query(
      `DELETE FROM intentos_login WHERE clave IN (
         SELECT clave FROM intentos_login
         WHERE actualizado_en < now() - interval '1 day' AND (bloqueado_hasta IS NULL OR bloqueado_hasta < now())
         FOR UPDATE SKIP LOCKED
       )`,
    )
    .catch((e: Error) => registro.error('intentos_login_limpieza_fallo', { mensaje: e.message }));
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
    const { rows } = await pool.query<{ intentos: number; bloqueado_hasta: Date | null }>(SUMAR_FALLO, [
      clave,
      config.max,
      config.ventanaMs,
      config.bloqueoBaseMs,
      config.bloqueoMaxMs,
    ]);
    // Sin fila: la cuenta ya estaba bloqueada y el fallo no cambia nada
    const fila = rows[0];
    const fallos = !fila || fila.bloqueado_hasta ? config.max : fila.intentos;
    await purgar(pool);
    return fallos;
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
// 3. Un inicio correcto reinicia el contador (si eso falla, entra igual y se registra) y se vuelve a revisar el
//    bloqueo, por si otros intentos simultáneos lo activaron mientras se probaba la contraseña.
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
    // Varios intentos pueden estar probando contraseñas a la vez: si mientras tanto la cuenta se bloqueó, ni siquiera
    // la contraseña correcta entra (si no, el bloqueo se saltaría con intentos simultáneos)
    await intentos.exigirSinBloqueo(clave);
    // La contraseña ya era correcta: si el contador no se puede reiniciar, la persona entra igual y el fallo se registra
    try {
      await intentos.limpiar(clave);
    } catch (e) {
      registro.error('intentos_login_fallo', { mensaje: (e as Error).message });
    }
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
