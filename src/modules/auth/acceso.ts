import { Router } from 'express';
import { z } from 'zod';
import { errores } from '../../shared/errores.js';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { parsear } from '../../shared/http/validacion.js';
import type { ServicioCuentas } from '../cuentas/cuentas.servicio.js';
import type { ServicioAuth } from './auth.servicio.js';
import { verificarContrasena } from './contrasenas.js';

// Login único: recibe "correo o usuario" y contraseña, y detecta si es la
// administradora de una empresa o un cliente con cuenta (tabla usuarios), o
// alguien del personal (barberos).
// Los logins de antes (/auth/login y /cuentas/login) siguen igual.

const FALTAN_DATOS = 'Debes enviar tu correo o usuario y tu contraseña';
const INCORRECTOS = 'Correo, usuario o contraseña incorrectos';

const esquemaLogin = z.object(
  {
    usuario: z.string({ error: FALTAN_DATOS }).trim().min(1, FALTAN_DATOS).max(254, FALTAN_DATOS),
    // bcrypt solo usa los primeros 72 bytes; 64 caracteres deja margen
    clave: z.string({ error: FALTAN_DATOS }).min(1, FALTAN_DATOS).max(64, FALTAN_DATOS),
  },
  { error: FALTAN_DATOS },
);

export const crearServicioAcceso = (auth: ServicioAuth, cuentas: ServicioCuentas) => ({
  async iniciarSesion(identificador: string, clave: string) {
    // Con @ es un correo: solo las cuentas tienen correo
    const esCorreo = identificador.includes('@');
    const cuenta = await cuentas.verificarCredenciales(
      esCorreo ? { correo: identificador.toLowerCase() } : { usuario: identificador },
      clave,
    );

    if (cuenta === null) throw errores.noAutenticado(INCORRECTOS);
    if (cuenta) {
      const tipo = cuenta.rol === 'admin' ? ('admin' as const) : ('cliente' as const);
      return { tipo, ...(await cuentas.respuestaLogin(cuenta)) };
    }

    if (esCorreo) {
      // Mismo trabajo que con una cuenta real, para no revelar qué correos existen
      await verificarContrasena(clave, undefined);
      throw errores.noAutenticado(INCORRECTOS);
    }

    // El usuario no se repite entre cuentas y personal, así que no hay ambigüedad
    // Igual que /auth/login, que recorta los espacios de la contraseña del personal
    const barbero = await auth.verificarCredenciales(identificador, clave.trim());
    if (!barbero) throw errores.noAutenticado(INCORRECTOS);
    return { tipo: 'personal' as const, ...(await auth.respuestaLogin(barbero)) };
  },
});

export const crearRutasAcceso = (auth: ServicioAuth, cuentas: ServicioCuentas, limitadores: Limitadores) => {
  const acceso = crearServicioAcceso(auth, cuentas);
  const rutas = Router();

  rutas.post('/', limitadores.login, async (req, res) => {
    const { usuario, clave } = parsear(esquemaLogin, req.body);
    res.json(await acceso.iniciarSesion(usuario, clave));
  });

  return rutas;
};
