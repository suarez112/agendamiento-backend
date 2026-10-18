import { Router } from 'express';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { parsear } from '../../shared/http/validacion.js';
import { type Guardias, sesionDe } from '../auth/guardias.js';
import { empresaDeAdmin, type GuardiasCuenta } from '../cuentas/cuentas.guardias.js';
import { esquemaActualizarEmpresa } from './empresas.esquemas.js';
import type { ServicioEmpresas } from './empresas.servicio.js';
import type { GuardiaSuscripcion } from './suscripcion.js';

export const crearRutasEmpresas = (
  empresas: ServicioEmpresas,
  guardias: Guardias,
  limitadores: Limitadores,
) => {
  const rutas = Router();

  rutas.get('/validar/:codigo', limitadores.codigoNegocio, async (req, res) => {
    res.json(await empresas.negocioPorCodigo(String(req.params.codigo)));
  });

  rutas.get('/actual', guardias.requerirSesion, async (_req, res) => {
    res.json(await empresas.negocioDeSesion(sesionDe(res).empresaId));
  });

  return rutas;
};

// Endpoints del administrador de una empresa (cuentas de la tabla usuarios).
// La empresa sale siempre de la sesión: no hay id en la URL ni en el cuerpo.
export const crearRutasAdminEmpresa = (
  empresas: ServicioEmpresas,
  guardias: GuardiasCuenta,
  suscripcion: GuardiaSuscripcion,
) => {
  const rutas = Router();
  const soloAdmin = [guardias.requerirCuenta, guardias.requerirAdminEmpresa];
  // Con la prueba vencida se bloquean, salvo la consulta de días restantes
  const adminConSuscripcion = [...soloAdmin, suscripcion.requerirSuscripcionVigente];

  rutas.get('/prueba', ...soloAdmin, async (_req, res) => {
    res.json(await empresas.estadoPrueba(empresaDeAdmin(res)));
  });

  rutas.get('/', ...adminConSuscripcion, async (_req, res) => {
    res.json(await empresas.perfilDeAdmin(empresaDeAdmin(res)));
  });

  rutas.patch('/', ...adminConSuscripcion, async (req, res) => {
    const cambios = parsear(esquemaActualizarEmpresa, req.body);
    res.json(await empresas.actualizarPerfil(empresaDeAdmin(res), cambios));
  });

  return rutas;
};
