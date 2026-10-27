import { Router } from 'express';
import { z } from 'zod';
import { errores } from '../../shared/errores.js';
import { parsear } from '../../shared/http/validacion.js';
import { esTokenExpo } from '../../shared/push.js';
import type { ServicioAuth } from '../auth/auth.servicio.js';
import { tokenDe } from '../auth/guardias.js';
import type { ServicioTokens } from '../auth/tokens.js';
import type { ServicioCuentas } from '../cuentas/cuentas.servicio.js';
import type { ServicioNotificaciones } from './notificaciones.servicio.js';
import type { Titular } from './notificaciones.repositorio.js';

// Dispositivos para notificaciones push. Sirve a cualquier sesión: personal del negocio
// (barbero), administradora o cliente con cuenta. El dueño del token sale siempre de la sesión.

const token = z
  .string({ error: 'Envía el token del dispositivo en "token"' })
  .trim()
  .min(1, 'Envía el token del dispositivo en "token"')
  .max(200, 'El token del dispositivo no es válido');

const esquemaRegistrar = z.object({
  token: token.refine(esTokenExpo, 'El token del dispositivo no es válido'),
  plataforma: z.enum(['ios', 'android', 'web'], { error: 'La plataforma debe ser "ios", "android" o "web"' }).optional(),
});
const esquemaQuitar = z.object({ token });

// Barbero → su id; cuenta (administradora o cliente) → su usuario. Un token inválido responde 401.
export const crearResolverTitular =
  (auth: ServicioAuth, cuentas: ServicioCuentas, tokens: ServicioTokens) =>
  async (jwt: string | undefined): Promise<Titular> => {
    if (!jwt) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
    if (tokens.verificar(jwt)) return { usuarioId: null, barberoId: (await auth.validarSesion(jwt)).barberoId };
    return { usuarioId: (await cuentas.validarSesion(jwt)).usuarioId, barberoId: null };
  };

export const crearRutasDispositivos = (
  notificaciones: ServicioNotificaciones,
  titularDe: ReturnType<typeof crearResolverTitular>,
) => {
  const rutas = Router();

  // Guarda (o actualiza) el token del celular. Llamar al iniciar sesión y cuando Expo cambie el token.
  rutas.put('/', async (req, res) => {
    const titular = await titularDe(tokenDe(req));
    const datos = parsear(esquemaRegistrar, req.body);
    await notificaciones.registrarDispositivo(titular, datos.token, datos.plataforma ?? null);
    res.json({ mensaje: 'Dispositivo registrado' });
  });

  // Al cerrar sesión. Responde igual si el token no existía.
  rutas.delete('/', async (req, res) => {
    const titular = await titularDe(tokenDe(req));
    const datos = parsear(esquemaQuitar, req.body);
    await notificaciones.borrarDispositivo(titular, datos.token);
    res.json({ mensaje: 'Dispositivo eliminado' });
  });

  return rutas;
};
