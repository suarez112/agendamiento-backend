import { Router } from 'express';
import { z } from 'zod';
import { claveNueva, conAlMenosUnDato, esquemaId, texto, textoOpcional } from '../../shared/http/esquemas.js';
import { parsear } from '../../shared/http/validacion.js';
import { sesionDe } from '../auth/guardias.js';
import type { Permisos } from '../auth/permisos.js';
import { recibirFoto, type UrlBase } from '../empresas/fotos.js';
import { funcionNoIncluida, type ServicioFunciones } from '../planes/funciones.js';
import type { ServicioEquipo } from './equipo.servicio.js';

const MENSAJE_USUARIO = 'El usuario debe tener entre 3 y 60 caracteres: letras, números, punto, guion o guion bajo';
const MENSAJE_PORCENTAJE = 'El porcentaje de ganancia debe ser un número entre 0 y 100';

const MENSAJE_ROL = 'El rol debe ser "admin" (Administrador) o "empleado" (Empleado)';

const campos = {
  nombre: texto('nombre', 100),
  usuario: z
    .string({ error: 'El campo "usuario" es obligatorio' })
    .trim()
    .regex(/^[A-Za-z0-9._-]{3,60}$/, MENSAJE_USUARIO),
  clave: claveNueva,
  // "admin" = Administrador, "empleado" = Empleado. esAdmin se mantiene para la app
  // de antes; si llegan los dos, manda rol.
  rol: z.enum(['admin', 'empleado'], { error: MENSAJE_ROL }).optional(),
  esAdmin: z.boolean({ error: 'El campo "esAdmin" debe ser true o false' }).optional(),
  // Si recibe reservas como profesional
  atiendeClientes: z.boolean({ error: 'El campo "atiendeClientes" debe ser true o false' }).optional(),
  especialidad: textoOpcional('especialidad', 100),
  porcentajeGanancia: z.number({ error: MENSAJE_PORCENTAJE }).min(0, MENSAJE_PORCENTAJE).max(100, MENSAJE_PORCENTAJE),
};

const esAdminSegun = (d: { rol?: 'admin' | 'empleado'; esAdmin?: boolean }) =>
  d.rol !== undefined ? d.rol === 'admin' : d.esAdmin;

// Alta: por defecto es empleado y atiende clientes; un administrador, por
// defecto, no atiende clientes (se activa con "atiendeClientes": true)
const esquemaMiembro = z
  .object({ ...campos, porcentajeGanancia: campos.porcentajeGanancia.default(50) }, {
    error: 'Envía los datos del profesional',
  })
  .transform(({ rol, ...d }) => {
    const esAdmin = esAdminSegun({ rol, esAdmin: d.esAdmin }) ?? false;
    return { ...d, esAdmin, atiendeClientes: d.atiendeClientes ?? !esAdmin };
  });

// En la edición nada tiene valor por defecto: lo que no llega, no cambia
const esquemaCambios = conAlMenosUnDato(
  z.object(campos, { error: 'Envía al menos un dato para actualizar' }).partial(),
).transform(({ rol, ...d }) => ({ ...d, esAdmin: esAdminSegun({ rol, esAdmin: d.esAdmin }) }));

const esquemaAtiende = z.object(
  { atiende: z.boolean({ error: 'Envía "atiende": true o false' }) },
  { error: 'Envía "atiende": true o false' },
);

const esquemaIdMiembro = esquemaId('Identificador de profesional inválido');

// Equipo del negocio de la sesión. Solo administradores.
export const crearRutasEquipo = (
  equipo: ServicioEquipo,
  permisos: Permisos,
  urlBase: UrlBase,
  funciones: ServicioFunciones,
) => {
  const rutas = Router();

  // Roles (administrador) y comisiones dependen del plan (src/config/funciones.ts)
  const validarPlan = async (empresaId: string, body: unknown, esAdmin: boolean | undefined) => {
    if (esAdmin === true && !(await funciones.incluida(empresaId, 'roles'))) throw funcionNoIncluida('roles');
    const conPorcentaje = (body as { porcentajeGanancia?: unknown } | undefined)?.porcentajeGanancia !== undefined;
    if (conPorcentaje && !(await funciones.incluida(empresaId, 'comisiones'))) throw funcionNoIncluida('comisiones');
  };

  // "Yo también atiendo clientes": solo la cuenta de administración (la de correo)
  rutas.get('/yo-atiendo', ...permisos.admin, async (req, res) => {
    res.json(await equipo.estadoAtiende(sesionDe(res), urlBase(req)));
  });

  rutas.put('/yo-atiendo', ...permisos.admin, async (req, res) => {
    const { atiende } = parsear(esquemaAtiende, req.body);
    res.json(await equipo.cambiarAtiende(sesionDe(res), atiende, urlBase(req)));
  });

  rutas.get('/', ...permisos.admin, async (req, res) => {
    res.json(await equipo.listar(sesionDe(res).empresaId, urlBase(req)));
  });

  rutas.post('/', ...permisos.admin, async (req, res) => {
    const datos = parsear(esquemaMiembro, req.body);
    await validarPlan(sesionDe(res).empresaId, req.body, datos.esAdmin);
    res.status(201).json(await equipo.crear(sesionDe(res).empresaId, datos, urlBase(req)));
  });

  rutas.patch('/:id', ...permisos.admin, async (req, res) => {
    const { id } = parsear(esquemaIdMiembro, req.params);
    const cambios = parsear(esquemaCambios, req.body);
    await validarPlan(sesionDe(res).empresaId, req.body, cambios.esAdmin);
    res.json(await equipo.actualizar(sesionDe(res), id, cambios, urlBase(req)));
  });

  rutas.delete('/:id', ...permisos.admin, async (req, res) => {
    const { id } = parsear(esquemaIdMiembro, req.params);
    res.json(await equipo.borrar(sesionDe(res), id));
  });

  // Foto del profesional (multipart/form-data, campo "foto"). Las guardias van
  // antes de leer el archivo: sin permiso no se recibe nada.
  rutas.put('/:id/foto', ...permisos.admin, recibirFoto, async (req, res) => {
    const { id } = parsear(esquemaIdMiembro, req.params);
    res.json(await equipo.cambiarFoto(sesionDe(res).empresaId, id, req.file!.buffer, urlBase(req)));
  });

  return rutas;
};
