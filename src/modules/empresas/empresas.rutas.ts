import { Router } from 'express';
import { z } from 'zod';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { parsear } from '../../shared/http/validacion.js';
import { type Guardias, sesionDe } from '../auth/guardias.js';
import { SOLO_ADMIN } from '../auth/permisos.js';
import { esquemaActualizarEmpresa, esquemaCodigoNegocio, esquemaIntervalo } from './empresas.esquemas.js';
import type { ServicioEmpresas } from './empresas.servicio.js';
import type { ServicioGuia } from './guia.js';
import { recibirFoto, type UrlBase } from './fotos.js';

export const crearRutasEmpresas = (
  empresas: ServicioEmpresas,
  guardias: Guardias,
  limitadores: Limitadores,
  urlBase: UrlBase,
) => {
  const rutas = Router();

  rutas.get('/validar/:codigo', limitadores.codigoNegocio, async (req, res) => {
    res.json(await empresas.negocioPorCodigo(String(req.params.codigo), urlBase(req)));
  });

  // ¿Algún negocio usa ya este código? Lo usan el registro y "Mi negocio" (público)
  rutas.get('/codigo-disponible/:codigo', limitadores.codigoNegocio, async (req, res) => {
    const { codigo } = parsear(z.object({ codigo: esquemaCodigoNegocio }), req.params);
    res.json(await empresas.codigoDisponible(codigo));
  });

  // Información del negocio con su foto, para los clientes (público)
  rutas.get('/perfil/:codigo', limitadores.codigoNegocio, async (req, res) => {
    res.json(await empresas.perfilPublico(String(req.params.codigo), urlBase(req)));
  });

  // Personal o cuenta del administrador de la empresa
  rutas.get('/actual', guardias.requerirSesion, async (req, res) => {
    res.json(await empresas.negocioDeSesion(sesionDe(res).empresaId, urlBase(req)));
  });

  return rutas;
};

// "Mi negocio" y la suscripción. Sirven a los dos tipos de administrador: la
// cuenta de la empresa y los integrantes del equipo marcados como administrador.
// La empresa sale siempre de la sesión: no hay id en la URL ni en el cuerpo.
// Funcionan aunque la suscripción haya vencido, para poder renovarla y corregir datos.
export const crearRutasAdminEmpresa = (empresas: ServicioEmpresas, guardias: Guardias, urlBase: UrlBase, guia: ServicioGuia) => {
  const rutas = Router();
  const soloAdmin = [guardias.requerirSesion, guardias.requerirAdmin(SOLO_ADMIN)];

  rutas.get('/prueba', ...soloAdmin, async (_req, res) => {
    res.json(await empresas.estadoPrueba(sesionDe(res).empresaId));
  });

  rutas.get('/suscripcion', ...soloAdmin, async (_req, res) => {
    res.json(await empresas.suscripcion(sesionDe(res).empresaId));
  });

  // Cada cuántos minutos pueden agendar los clientes (10, 20, 30, 40, 50 o 60)
  rutas.get('/intervalo', ...soloAdmin, async (_req, res) => {
    res.json(await empresas.intervalo(sesionDe(res).empresaId));
  });

  rutas.put('/intervalo', ...soloAdmin, async (req, res) => {
    const { intervaloMinutos } = parsear(esquemaIntervalo, req.body);
    res.json(await empresas.cambiarIntervalo(sesionDe(res).empresaId, intervaloMinutos));
  });

  // Guía inicial: avance en 3 pasos (servicio, horario y enlace compartido)
  rutas.get('/guia', ...soloAdmin, async (_req, res) => {
    res.json(await guia.guia(sesionDe(res).empresaId));
  });

  // La app lo llama al tocar Compartir o Copiar el enlace del negocio
  rutas.post('/guia/enlace-compartido', ...soloAdmin, async (_req, res) => {
    res.json(await guia.marcarEnlaceCompartido(sesionDe(res).empresaId));
  });

  rutas.post('/guia/ocultar', ...soloAdmin, async (_req, res) => {
    res.json(await guia.cambiarOculta(sesionDe(res).empresaId, true));
  });

  rutas.post('/guia/mostrar', ...soloAdmin, async (_req, res) => {
    res.json(await guia.cambiarOculta(sesionDe(res).empresaId, false));
  });

  rutas.get('/', ...soloAdmin, async (req, res) => {
    res.json(await empresas.perfilDeAdmin(sesionDe(res).empresaId, urlBase(req)));
  });

  rutas.patch('/', ...soloAdmin, async (req, res) => {
    const cambios = parsear(esquemaActualizarEmpresa, req.body);
    res.json(await empresas.actualizarPerfil(sesionDe(res).empresaId, cambios, urlBase(req)));
  });

  // Sube o cambia la foto del negocio (multipart/form-data, campo "foto").
  // Las guardias van antes de leer el archivo: sin permiso no se recibe nada.
  rutas.put('/foto', ...soloAdmin, recibirFoto, async (req, res) => {
    res.json(await empresas.cambiarFoto(sesionDe(res).empresaId, req.file!.buffer, urlBase(req)));
  });

  return rutas;
};
