import { aIsoEnZona } from '../../shared/zonaHoraria.js';
import { type RequestHandler, Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { errores } from '../../shared/errores.js';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { esquemaId } from '../../shared/http/esquemas.js';
import { parsear } from '../../shared/http/validacion.js';
import { cuentaDe, type GuardiasCuenta } from '../cuentas/cuentas.guardias.js';
import { buscarSuscripcion } from '../empresas/empresas.repositorio.js';
import { esquemaCodigoNegocio } from '../empresas/empresas.esquemas.js';
import { urlFoto, type UrlBase } from '../empresas/fotos.js';
import type { Avisos } from '../notificaciones/notificaciones.servicio.js';
import * as repositorio from './micuenta.repositorio.js';
import type { FilaNegocioGuardado } from './micuenta.repositorio.js';

// "Mi cuenta" de un cliente registrado: negocios guardados (para no escribir el
// código cada vez) y las citas que reservó con su sesión (puede cancelarlas). Solo cuentas de cliente.

const NO_ENCONTRADO = 'Establecimiento no encontrado';

export const crearServicioMiCuenta = ({ pool, notificaciones }: { pool: pg.Pool; notificaciones?: Avisos }) => {
  const armarNegocio = async (n: FilaNegocioGuardado, urlBase: string) => ({
    id: n.id,
    nombre: n.nombre,
    codigoAcceso: n.codigo_acceso,
    categoria: n.categoria,
    direccion: n.direccion,
    departamento: n.departamento,
    ciudad: n.ciudad,
    logoUrl: n.logo_url,
    fotoUrl: urlFoto(urlBase, n.foto_url),
    recibiendoReservas: Boolean((await buscarSuscripcion(pool, n.id))?.habilitada),
    guardadoEn: aIsoEnZona(n.guardado_en, n.zona_horaria),
    zonaHoraria: n.zona_horaria,
  });

  return {
    async negocios(usuarioId: string, urlBase: string) {
      const filas = await repositorio.listarNegociosGuardados(pool, usuarioId);
      return Promise.all(filas.map((n) => armarNegocio(n, urlBase)));
    },

    async guardarNegocio(usuarioId: string, codigo: string, urlBase: string) {
      const negocio = await repositorio.guardarNegocio(pool, usuarioId, codigo);
      if (!negocio) throw errores.noEncontrado(NO_ENCONTRADO);
      return { mensaje: 'Negocio guardado', negocio: await armarNegocio(negocio, urlBase) };
    },

    async quitarNegocio(usuarioId: string, empresaId: string) {
      if (!(await repositorio.quitarNegocio(pool, usuarioId, empresaId))) {
        throw errores.noEncontrado('Ese negocio no está en tu lista');
      }
      return { mensaje: 'Negocio quitado de tu lista' };
    },

    async citas(usuarioId: string) {
      return (await repositorio.listarCitasCliente(pool, usuarioId)).map((c) => ({
        id: c.id,
        empresaId: c.empresa_id,
        negocio: c.negocio,
        codigoAcceso: c.codigo_acceso,
        servicio: c.servicio,
        barberoId: c.barbero_id,
        barberoNombre: c.barbero_nombre,
        fecha: c.fecha,
        hora: c.hora,
        duracionMin: c.duracion_min,
        precio: Number(c.precio),
        estado: c.estado,
        zonaHoraria: c.zona_horaria,
      }));
    },

    async cancelarCita(usuarioId: string, citaId: string) {
      const r = await repositorio.cancelarCitaCliente(pool, { id: citaId, usuarioId });
      if (!r) {
        throw errores.conflicto(
          'No se pudo cancelar: la cita no existe, no es tuya, ya fue atendida o cancelada, o ya empezó.',
        );
      }
      // Aviso al profesional y a los administradores, sin esperar a que termine el envío
      void notificaciones?.avisarCancelacionPorCliente(citaId);
      return { mensaje: 'Cita cancelada', estado: r.estado, canceladaEn: aIsoEnZona(r.cancelada_en, r.zona_horaria), zonaHoraria: r.zona_horaria };
    },
  };
};

export type ServicioMiCuenta = ReturnType<typeof crearServicioMiCuenta>;

// Solo cuentas de cliente; una administradora usa sus propios endpoints
const requerirCliente: RequestHandler = (_req, res, next) => {
  if (cuentaDe(res).rol !== 'cliente') throw errores.prohibido('Esta función es solo para clientes con cuenta.');
  next();
};

const esquemaGuardar = z.object({ codigo: esquemaCodigoNegocio }, { error: 'Envía el código del negocio en "codigo"' });
const esquemaIdNegocio = esquemaId('Identificador de negocio inválido');
const esquemaIdCita = esquemaId('Identificador de cita inválido');

export const crearRutasMiCuenta = (
  miCuenta: ServicioMiCuenta,
  guardias: GuardiasCuenta,
  limitadores: Limitadores,
  urlBase: UrlBase,
) => {
  const rutas = Router();
  const soloCliente = [guardias.requerirCuenta, requerirCliente];

  rutas.get('/negocios', ...soloCliente, async (req, res) => {
    res.json(await miCuenta.negocios(cuentaDe(res).usuarioId, urlBase(req)));
  });

  // Mismo límite por IP que /empresas/validar/:codigo, para no probar códigos al azar
  rutas.post('/negocios', limitadores.codigoNegocio, ...soloCliente, async (req, res) => {
    const { codigo } = parsear(esquemaGuardar, req.body);
    res.status(201).json(await miCuenta.guardarNegocio(cuentaDe(res).usuarioId, codigo, urlBase(req)));
  });

  rutas.delete('/negocios/:id', ...soloCliente, async (req, res) => {
    const { id } = parsear(esquemaIdNegocio, req.params);
    res.json(await miCuenta.quitarNegocio(cuentaDe(res).usuarioId, id));
  });

  rutas.get('/citas', ...soloCliente, async (_req, res) => {
    res.json(await miCuenta.citas(cuentaDe(res).usuarioId));
  });

  rutas.patch('/citas/:id/cancelar', ...soloCliente, async (req, res) => {
    const { id } = parsear(esquemaIdCita, req.params);
    res.json(await miCuenta.cancelarCita(cuentaDe(res).usuarioId, id));
  });

  return rutas;
};
