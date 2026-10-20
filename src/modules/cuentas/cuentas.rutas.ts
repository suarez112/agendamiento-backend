import { Router } from 'express';
import { z } from 'zod';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { parsear } from '../../shared/http/validacion.js';
import {
  conUbicacionValida,
  esquemaCorreo,
  esquemaPerfilEmpresa,
  esquemaUsuarioAdmin,
} from '../empresas/empresas.esquemas.js';
import { texto } from '../../shared/http/esquemas.js';
import { esquemaIndicativo } from '../citas/citas.esquemas.js';
import { conTelefonoNormalizado } from '../../shared/telefonos.js';
import { aceptacionObligatoria } from '../legal/legal.js';
import type { ServicioCuentas } from './cuentas.servicio.js';
import type { ServicioRecuperacion } from './recuperacion.servicio.js';

const MENSAJE_CLAVE = 'La contraseña debe tener entre 8 y 64 caracteres';

// bcrypt solo usa los primeros 72 bytes; 64 caracteres deja margen
const esquemaClave = z.string({ error: MENSAJE_CLAVE }).min(8, MENSAJE_CLAVE).max(64, MENSAJE_CLAVE);

// La administradora entra con su correo o su usuario, y su contraseña
// Debe aceptar la Política de Tratamiento de Datos y los Términos y Condiciones
const esquemaRegistroEmpresa = conUbicacionValida(
  esquemaPerfilEmpresa.extend({
    correo: esquemaCorreo,
    usuario: esquemaUsuarioAdmin,
    clave: esquemaClave,
    ...aceptacionObligatoria,
  }),
);

const CORREO_O_USUARIO = 'Envía tu correo o un nombre de usuario para iniciar sesión';

// Cuenta de cliente: nombre y teléfono (se usan al reservar), correo o usuario
// (o los dos) para iniciar sesión, contraseña y la aceptación de los documentos
const esquemaRegistroCliente = z
  .object(
    {
      nombre: texto('nombre', 100),
      telefono: texto('teléfono', 30),
      indicativo: esquemaIndicativo,
      correo: esquemaCorreo.optional(),
      usuario: esquemaUsuarioAdmin.optional(),
      clave: esquemaClave,
      ...aceptacionObligatoria,
    },
    { error: 'Envía tus datos para crear la cuenta' },
  )
  .refine((d) => d.correo !== undefined || d.usuario !== undefined, { error: CORREO_O_USUARIO })
  .transform(conTelefonoNormalizado);

const FALTAN_DATOS = 'Debes enviar correo y contraseña';

const esquemaLogin = z.object(
  {
    correo: z.string({ error: FALTAN_DATOS }).trim().toLowerCase().min(1, FALTAN_DATOS).max(254, FALTAN_DATOS),
    clave: z.string({ error: FALTAN_DATOS }).min(1, FALTAN_DATOS).max(64, FALTAN_DATOS),
  },
  { error: FALTAN_DATOS },
);

const esquemaSolicitarRecuperacion = z.object({ correo: esquemaCorreo }, { error: 'Envía el correo de tu cuenta' });

const MENSAJE_CODIGO = 'El código debe tener 6 dígitos';

// La contraseña nueva sigue las mismas reglas del registro
const esquemaRestablecer = z.object(
  {
    correo: esquemaCorreo,
    codigo: z.string({ error: MENSAJE_CODIGO }).trim().regex(/^\d{6}$/, MENSAJE_CODIGO),
    clave: esquemaClave,
  },
  { error: 'Envía tu correo, el código y la contraseña nueva' },
);

export const crearRutasCuentas = (
  cuentas: ServicioCuentas,
  recuperacion: ServicioRecuperacion,
  limitadores: Limitadores,
) => {
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

  // Recuperar contraseña (administradoras y clientes con correo). Límite por
  // conexión y, al pedir el código, también por correo.
  rutas.post('/solicitar-recuperacion', limitadores.recuperacion, limitadores.recuperacionPorCorreo, async (req, res) => {
    const { correo } = parsear(esquemaSolicitarRecuperacion, req.body);
    res.json(await recuperacion.solicitar(correo));
  });

  rutas.post('/restablecer-contrasena', limitadores.recuperacion, async (req, res) => {
    res.json(await recuperacion.restablecer(parsear(esquemaRestablecer, req.body)));
  });

  return rutas;
};
