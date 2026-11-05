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
  cursor: z.string({ error: CURSOR_INVALIDO }).min(1, CURSOR_INVALIDO).max(500, CURSOR_INVALIDO).optional(),
  q: z
    .string({ error: 'La búsqueda debe ser un texto' })
    .max(100, 'La búsqueda puede tener hasta 100 caracteres')
    .refine((q) => !q.includes('\u0000'), 'La búsqueda debe ser un texto')
    .optional(),
});
// Con cualquiera de estos parámetros la respuesta es una página; sin ninguno, la lista completa de siempre
const PARAMETROS_PAGINA = ['limite', 'cursor', 'q'];
const esquemaIdCliente = esquemaId('Identificador de cliente inválido');
const esquemaIdEntrada = esquemaId('Identificador de la lista negra inválido');

// Clientes del negocio de la sesión. Solo administradores (tienen datos personales).
export const crearRutasClientes = (clientes: ServicioClientes, permisos: Permisos) => {
  const rutas = Router();

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
