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
import { claveNueva, texto } from '../../shared/http/esquemas.js';
import { esquemaIndicativo } from '../citas/citas.esquemas.js';
import { conTelefonoNormalizado } from '../../shared/telefonos.js';
import { aceptacionObligatoria } from '../legal/legal.js';
import { cuentaDe, type GuardiasCuenta } from './cuentas.guardias.js';
import type { ServicioCuentas } from './cuentas.servicio.js';
import type { ServicioEliminacion } from './eliminacion.servicio.js';
import type { ServicioRecuperacion } from './recuperacion.servicio.js';

const esquemaClave = claveNueva;

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

// Para eliminar la cuenta se confirma con la contraseña
const esquemaEliminar = z.object(
  {
    clave: z.string({ error: 'Envía tu contraseña para confirmar' }).min(1, 'Envía tu contraseña para confirmar').max(64),
    eliminarNegocio: z.boolean({ error: '"eliminarNegocio" debe ser true o false' }).default(false),
  },
  { error: 'Envía tu contraseña para confirmar' },
);

export const crearRutasCuentas = (
  cuentas: ServicioCuentas,
  recuperacion: ServicioRecuperacion,
  eliminacion: ServicioEliminacion,
  guardias: GuardiasCuenta,
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

  // Elimina la cuenta de una administradora o de un cliente (los fallos de contraseña cuentan como intentos de login)
  rutas.post('/eliminar', limitadores.login, guardias.requerirCuenta, async (req, res) => {
    res.json(await eliminacion.eliminar(cuentaDe(res), parsear(esquemaEliminar, req.body)));
  });

  return rutas;
};
