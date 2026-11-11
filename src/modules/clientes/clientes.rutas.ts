import { Router } from 'express';
import { z } from 'zod';
import { esquemaId } from '../../shared/http/esquemas.js';
import { parsear } from '../../shared/http/validacion.js';
import { sesionDe } from '../auth/guardias.js';
import type { Permisos } from '../auth/permisos.js';
import { CURSOR_INVALIDO, type ServicioClientes } from './clientes.servicio.js';

const MENSAJE_CLIENTE = 'Envía el identificador del cliente en "clienteId"';

const esquemaAgregar = z.object(
  { clienteId: z.string({ error: MENSAJE_CLIENTE }).trim().min(1, MENSAJE_CLIENTE).max(64, MENSAJE_CLIENTE) },
  { error: MENSAJE_CLIENTE },
);
const MENSAJE_LIMITE = 'El límite debe ser un número entero entre 1 y 50';
const esquemaPagina = z.object({
  limite: z.coerce.number({ error: MENSAJE_LIMITE }).int(MENSAJE_LIMITE).min(1, MENSAJE_LIMITE).max(50, MENSAJE_LIMITE).default(20),
  cursor: z.string({ error: CURSOR_INVALIDO }).min(1, CURSOR_INVALIDO).max(100, CURSOR_INVALIDO).optional(),
  q: z
    .string({ error: 'La búsqueda debe ser un texto' })
    .max(100, 'La búsqueda puede tener hasta 100 caracteres')
    .refine((q) => !q.includes('\u0000'), 'La búsqueda debe ser un texto')
    .optional(),
});
// Con cualquiera de estos parámetros la respuesta es una página; sin ninguno, la lista completa de siempre
const PARAMETROS_PAGINA = ['limite', 'cursor', 'q'];
// Selector: de 3 a 100 caracteres, los dos sin contar los espacios de los extremos (sin "q" también es el 400 del mínimo)
const MINIMO_BUSQUEDA = 'Escribe al menos 3 caracteres para buscar';
const esquemaSelector = z.object({
  q: z
    .string({ error: (i) => (i.input === undefined ? MINIMO_BUSQUEDA : 'La búsqueda debe ser un texto') })
    .refine((q) => !q.includes('\u0000'), 'La búsqueda debe ser un texto')
    .transform((q) => q.trim())
    .refine((q) => q.length <= 100, 'La búsqueda puede tener hasta 100 caracteres')
    .refine((q) => q.length >= 3, MINIMO_BUSQUEDA),
});
const esquemaIdCliente = esquemaId('Identificador de cliente inválido');
const esquemaIdEntrada = esquemaId('Identificador de la lista negra inválido');

// Clientes del negocio de la sesión. Solo administradores (tienen datos personales), salvo el selector.
export const crearRutasClientes = (clientes: ServicioClientes, permisos: Permisos) => {
  const rutas = Router();

  // Selector de "cliente existente": administradores y empleados del negocio de la sesión (nunca de la URL).
  // Máximo 10 resultados; el teléfono, y buscar por él, solo si la sesión puede ver teléfonos.
  rutas.get('/buscar', ...permisos.personal, async (req, res) => {
    const { q } = parsear(esquemaSelector, req.query);
    res.json(await clientes.buscarParaSelector(sesionDe(res), q));
  });

  rutas.get('/', ...permisos.admin, async (req, res) => {
    const { empresaId } = sesionDe(res);
    if (!PARAMETROS_PAGINA.some((p) => p in req.query)) {
      res.json(await clientes.listar(empresaId));
      return;
    }
    res.json(await clientes.listarPagina(empresaId, parsear(esquemaPagina, req.query)));
  });

  rutas.get('/lista-negra', ...permisos.admin, async (_req, res) => {
    res.json(await clientes.listaNegra(sesionDe(res).empresaId));
  });

  rutas.post('/lista-negra', ...permisos.admin, async (req, res) => {
    const { clienteId } = parsear(esquemaAgregar, req.body);
    res.status(201).json(await clientes.agregarAListaNegra(sesionDe(res).empresaId, clienteId));
  });

  rutas.delete('/lista-negra/:id', ...permisos.admin, async (req, res) => {
    const { id } = parsear(esquemaIdEntrada, req.params);
    res.json(await clientes.quitarDeListaNegra(sesionDe(res).empresaId, id));
  });

  rutas.get('/:id/historial', ...permisos.admin, async (req, res) => {
    const { id } = parsear(esquemaIdCliente, req.params);
    res.json(await clientes.historial(sesionDe(res).empresaId, id));
  });

  return rutas;
};
