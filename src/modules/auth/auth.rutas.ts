import { Router } from 'express';
import { z } from 'zod';
import { ipDe } from '../../shared/http/ip.js';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { parsear } from '../../shared/http/validacion.js';
import type { ServicioAuth } from './auth.servicio.js';
import { conContadorDeCuenta, type ServicioIntentos } from './intentos.js';

const FALTAN_DATOS = 'Debes enviar usuario y contraseña';

const esquemaLogin = z.object(
  {
    usuario: z.string({ error: FALTAN_DATOS }).trim().min(1, FALTAN_DATOS).max(60, FALTAN_DATOS),
    // bcrypt solo usa los primeros 72 bytes; 64 caracteres deja margen
    clave: z.string({ error: FALTAN_DATOS }).trim().min(1, FALTAN_DATOS).max(64, FALTAN_DATOS),
  },
  { error: FALTAN_DATOS },
);

export const crearRutasAuth = (auth: ServicioAuth, limitadores: Limitadores, intentos: ServicioIntentos) => {
  const rutas = Router();

  rutas.post('/login', limitadores.loginPersonal, async (req, res) => {
    const { usuario, clave } = parsear(esquemaLogin, req.body);
    res.json(
      await conContadorDeCuenta(intentos, intentos.claveDe('cuenta', usuario), { ruta: '/auth/login', ip: ipDe(req) }, () =>
        auth.iniciarSesion(usuario, clave),
      ),
    );
  });

  return rutas;
};
