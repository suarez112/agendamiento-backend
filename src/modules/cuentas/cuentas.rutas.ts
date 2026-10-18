import { Router } from 'express';
import { z } from 'zod';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { parsear } from '../../shared/http/validacion.js';
import { conHorarioValido, esquemaCorreo, esquemaPerfilEmpresa } from '../empresas/empresas.esquemas.js';
import type { ServicioCuentas } from './cuentas.servicio.js';

const MENSAJE_CLAVE = 'La contraseña debe tener entre 8 y 64 caracteres';

// bcrypt solo usa los primeros 72 bytes; 64 caracteres deja margen
const esquemaClave = z.string({ error: MENSAJE_CLAVE }).min(8, MENSAJE_CLAVE).max(64, MENSAJE_CLAVE);

// El correo de la empresa es también el correo con el que entra su administrador
const esquemaRegistroEmpresa = conHorarioValido(esquemaPerfilEmpresa.extend({ clave: esquemaClave }));

const esquemaRegistroCliente = z.object(
  { correo: esquemaCorreo, clave: esquemaClave },
  { error: 'Envía correo y contraseña' },
);

const FALTAN_DATOS = 'Debes enviar correo y contraseña';

const esquemaLogin = z.object(
  {
    correo: z.string({ error: FALTAN_DATOS }).trim().toLowerCase().min(1, FALTAN_DATOS).max(254, FALTAN_DATOS),
    clave: z.string({ error: FALTAN_DATOS }).min(1, FALTAN_DATOS).max(64, FALTAN_DATOS),
  },
  { error: FALTAN_DATOS },
);

export const crearRutasCuentas = (cuentas: ServicioCuentas, limitadores: Limitadores) => {
  const rutas = Router();

  rutas.post('/registro/empresa', limitadores.registro, async (req, res) => {
    res.status(201).json(await cuentas.registrarEmpresa(parsear(esquemaRegistroEmpresa, req.body)));
  });

  rutas.post('/registro/cliente', limitadores.registro, async (req, res) => {
    res.status(201).json(await cuentas.registrarCliente(parsear(esquemaRegistroCliente, req.body)));
  });

  rutas.post('/login', limitadores.login, async (req, res) => {
    res.json(await cuentas.iniciarSesion(parsear(esquemaLogin, req.body)));
  });

  return rutas;
};
