import { Router } from 'express';
import { z } from 'zod';
import { conAlMenosUnDato, esquemaId, precio, texto, textoOpcional } from '../../shared/http/esquemas.js';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { parsear } from '../../shared/http/validacion.js';
import { sesionDe } from '../auth/guardias.js';
import type { Permisos } from '../auth/permisos.js';
import { recibirFoto, type UrlBase } from '../empresas/fotos.js';
import type { ServicioProductos } from './productos.servicio.js';

const esquemaProducto = z.object(
  {
    nombre: texto('nombre', 100),
    precio: precio('precio'),
    descripcion: textoOpcional('descripción', 500),
  },
  { error: 'Envía los datos del producto' },
);

const esquemaCambios = conAlMenosUnDato(esquemaProducto.partial());
const esquemaIdProducto = esquemaId('Identificador de producto inválido');

export const crearRutasProductos = (
  productos: ServicioProductos,
  permisos: Permisos,
  limitadores: Limitadores,
  urlBase: UrlBase,
) => {
  const rutas = Router();

  // Público: catálogo que ven los clientes con el código del negocio
  rutas.get('/catalogo/:codigo', limitadores.codigoNegocio, async (req, res) => {
    res.json(await productos.catalogo(String(req.params.codigo), urlBase(req)));
  });

  // Gestión: solo administradores del negocio de la sesión
  rutas.get('/', ...permisos.admin, async (req, res) => {
    res.json(await productos.listar(sesionDe(res).empresaId, urlBase(req)));
  });

  rutas.post('/', ...permisos.admin, async (req, res) => {
    const datos = parsear(esquemaProducto, req.body);
    res.status(201).json(await productos.crear(sesionDe(res).empresaId, datos, urlBase(req)));
  });

  rutas.patch('/:id', ...permisos.admin, async (req, res) => {
    const { id } = parsear(esquemaIdProducto, req.params);
    const cambios = parsear(esquemaCambios, req.body);
    res.json(await productos.actualizar(sesionDe(res).empresaId, id, cambios, urlBase(req)));
  });

  rutas.delete('/:id', ...permisos.admin, async (req, res) => {
    const { id } = parsear(esquemaIdProducto, req.params);
    res.json(await productos.borrar(sesionDe(res).empresaId, id));
  });

  // Foto opcional (multipart/form-data, campo "foto"). Las guardias van antes de
  // leer el archivo: sin permiso no se recibe nada.
  rutas.put('/:id/foto', ...permisos.admin, recibirFoto, async (req, res) => {
    const { id } = parsear(esquemaIdProducto, req.params);
    res.json(await productos.cambiarFoto(sesionDe(res).empresaId, id, req.file!.buffer, urlBase(req)));
  });

  rutas.delete('/:id/foto', ...permisos.admin, async (req, res) => {
    const { id } = parsear(esquemaIdProducto, req.params);
    res.json(await productos.quitarFoto(sesionDe(res).empresaId, id));
  });

  return rutas;
};
