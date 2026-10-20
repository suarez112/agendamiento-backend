import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { enTransaccion } from '../../db/pool.js';
import type { EnviadorCorreo } from '../../shared/correo.js';
import { errores } from '../../shared/errores.js';
import { registro } from '../../shared/registro.js';
import { cifrarContrasena } from '../auth/contrasenas.js';
import * as repositorio from './cuentas.repositorio.js';

// Recuperar la contraseña de una cuenta (administradora o cliente) con su correo:
// 1. solicitar: si el correo es de una cuenta, se envía un código de 6 dígitos.
// 2. restablecer: con el correo, el código y la contraseña nueva.
// El código se guarda como HMAC (nunca el código), vence en 15 minutos, sirve una
// sola vez y se bloquea tras 5 intentos fallidos.

export const MINUTOS_CODIGO = 15;
export const MAX_INTENTOS_CODIGO = 5;

// La misma respuesta exista o no la cuenta, para no revelar qué correos están registrados
const MENSAJE_SOLICITUD = `Si el correo pertenece a una cuenta, te enviamos un código de 6 dígitos para restablecer tu contraseña. Vence en ${MINUTOS_CODIGO} minutos.`;
// Un solo mensaje para todos los fallos (cuenta inexistente, código errado, vencido,
// usado o bloqueado): así tampoco se revela si la cuenta existe
const CODIGO_INVALIDO = 'El código no es válido, ya venció o se bloqueó por demasiados intentos. Solicita uno nuevo.';

type Dependencias = { pool: pg.Pool; secreto: string; correo: EnviadorCorreo };

export type DatosRestablecer = { correo: string; codigo: string; clave: string };

export const crearServicioRecuperacion = ({ pool, secreto, correo }: Dependencias) => {
  // Ligado a la cuenta: el mismo código de otra cuenta da otro HMAC
  const hmac = (usuarioId: string, codigo: string) =>
    createHmac('sha256', secreto).update(`recuperacion:${usuarioId}:${codigo}`).digest();

  return {
    async solicitar(correoCuenta: string) {
      const usuario = await repositorio.buscarUsuarioPorCorreo(pool, correoCuenta);
      if (usuario?.correo) {
        const codigo = randomInt(0, 1_000_000).toString().padStart(6, '0');
        await enTransaccion(pool, (tx) =>
          repositorio.guardarCodigoRecuperacion(tx, {
            usuarioId: usuario.id,
            codigoHash: hmac(usuario.id, codigo).toString('hex'),
            minutos: MINUTOS_CODIGO,
          }),
        );
        // Sin esperar el envío: el tiempo de respuesta no debe revelar si la cuenta existe
        correo
          .enviar({
            para: usuario.correo,
            asunto: 'Tu código para restablecer la contraseña',
            texto:
              `Tu código para restablecer la contraseña es: ${codigo}\n\n` +
              `Vence en ${MINUTOS_CODIGO} minutos y sirve una sola vez. Si no lo pediste, ignora este correo: ` +
              'tu contraseña no cambia.',
          })
          .catch((error: unknown) => registro.error('correo_no_enviado', { mensaje: (error as Error).message }));
      }
      return { mensaje: MENSAJE_SOLICITUD };
    },

    // Cambia la contraseña y cierra todas las sesiones abiertas de la cuenta
    async restablecer({ correo: correoCuenta, codigo, clave }: DatosRestablecer) {
      const passwordHash = await cifrarContrasena(clave);
      const usuario = await repositorio.buscarUsuarioPorCorreo(pool, correoCuenta);
      // El intento fallido se guarda aunque la respuesta sea un error: por eso la
      // transacción devuelve el resultado en vez de lanzar el error adentro
      const cambiada =
        !!usuario &&
        (await enTransaccion(pool, async (tx) => {
          const vigente = await repositorio.buscarCodigoVigente(tx, usuario.id, MAX_INTENTOS_CODIGO);
          if (!vigente) return false;
          if (!timingSafeEqual(Buffer.from(vigente.codigo_hash, 'hex'), hmac(usuario.id, codigo))) {
            await repositorio.sumarIntentoFallido(tx, vigente.id);
            return false;
          }
          await repositorio.marcarCodigoUsado(tx, vigente.id);
          await repositorio.cambiarContrasena(tx, usuario.id, passwordHash);
          return true;
        }));
      if (!cambiada) throw errores.solicitudInvalida(CODIGO_INVALIDO);
      return { mensaje: 'Tu contraseña se cambió. Inicia sesión con tu nueva contraseña.' };
    },
  };
};

export type ServicioRecuperacion = ReturnType<typeof crearServicioRecuperacion>;
