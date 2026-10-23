import { type RequestHandler, Router } from 'express';
import { z } from 'zod';
import type { IdFuncion } from '../../config/funciones.js';
import { parsear } from '../../shared/http/validacion.js';
import { sesionDe } from '../auth/guardias.js';
import type { Permisos } from '../auth/permisos.js';
import { esquemaPeriodo } from '../cartera/cartera.rutas.js';
import { requerirFuncion, type ServicioFunciones } from '../planes/funciones.js';
import { aCsv } from './csv.js';
import type { ServicioExportacion } from './exportacion.js';
import type { ServicioReportes } from './reportes.servicio.js';

// Reportes solo para administradores, con los mismos filtros de período de la cartera:
// ?periodo=hoy|semana|mes|rango (con desde y hasta) y, opcional, barberoId.
// Cada reporte exige una función del plan (src/config/funciones.ts). Con ?formato=csv se
// descarga la tabla principal del reporte (función "exportar_reportes").
export const crearRutasReportes = (
  reportes: ServicioReportes,
  exportacion: ServicioExportacion,
  permisos: Permisos,
  funciones: ServicioFunciones,
) => {
  const rutas = Router();

  const exportable: RequestHandler = async (req, res, next) => {
    if (req.query.formato === 'csv') await requerirFuncion(funciones, 'exportar_reportes')(req, res, next);
    else next();
  };

  const responder = (
    funcion: IdFuncion,
    nombre: string,
    generar: (empresaId: string, consulta: ReturnType<typeof esquemaPeriodo.parse>) => Promise<object>,
    filasCsv: (r: never) => Record<string, unknown>[],
  ) =>
    rutas.get(`/${nombre}`, ...permisos.admin, requerirFuncion(funciones, funcion), exportable, async (req, res) => {
      const resultado = await generar(sesionDe(res).empresaId, parsear(esquemaPeriodo, req.query));
      if (req.query.formato === 'csv') {
        res.type('text/csv; charset=utf-8').attachment(`${nombre}.csv`).send(aCsv(filasCsv(resultado as never)));
        return;
      }
      res.json(resultado);
    });

  responder('ocupacion_profesional', 'ocupacion', (e, c) => reportes.ocupacion(e, c), (r: { porProfesional: Record<string, unknown>[] }) => r.porProfesional);
  responder('servicios_rentables', 'servicios-rentables', (e, c) => reportes.serviciosRentables(e, c), (r: { servicios: Record<string, unknown>[] }) => r.servicios);
  responder('demanda', 'demanda', (e, c) => reportes.demanda(e, c), (r: { mapa: Record<string, unknown>[] }) => r.mapa);

  // Reportes avanzados (plan Pro): mejores clientes, clientes que volvieron y tendencia mes a mes
  responder('reportes_avanzados', 'mejores-clientes', (e, c) => reportes.mejoresClientes(e, c), (r: { masGastan: Record<string, unknown>[] }) => r.masGastan);
  responder('reportes_avanzados', 'retencion-clientes', (e, c) => reportes.retencionClientes(e, c), (r: object) => [r as Record<string, unknown>]);
  responder('reportes_avanzados', 'tendencia', (e, c) => reportes.tendencia(e, c), (r: { meses: Record<string, unknown>[] }) => r.meses);

  // Reporte del período en Excel o PDF, con la cartera y los reportes (plan Pro): ?formato=xlsx|pdf
  const MENSAJE_FORMATO = 'Elige el formato en "formato": "xlsx" o "pdf"';
  const esquemaFormato = z.object({ formato: z.enum(['xlsx', 'pdf'], { error: MENSAJE_FORMATO }) }, { error: MENSAJE_FORMATO });
  rutas.get(
    '/exportar',
    ...permisos.admin,
    requerirFuncion(funciones, 'exportar_reportes'),
    requerirFuncion(funciones, 'reportes_avanzados'),
    async (req, res) => {
      const { formato } = parsear(esquemaFormato, req.query);
      const consulta = parsear(esquemaPeriodo, req.query);
      const { archivo, tipo, contenido } = await exportacion.exportar(sesionDe(res), consulta, formato);
      res.type(tipo).attachment(archivo).send(contenido);
    },
  );

  return rutas;
};
