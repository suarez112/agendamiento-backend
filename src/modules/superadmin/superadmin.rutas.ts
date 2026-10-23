import { type RequestHandler, Router } from 'express';
import { z } from 'zod';
import { errores } from '../../shared/errores.js';
import { esquemaId, fecha, obligatorio, texto } from '../../shared/http/esquemas.js';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { parsear } from '../../shared/http/validacion.js';
import { tokenDe } from '../auth/guardias.js';
import type { ServicioCategorias } from '../categorias/categorias.servicio.js';
import { ESTADOS_PQRS, TIPOS_PQRS } from '../pqrs/pqrs.repositorio.js';
import { ESTADOS_NEGOCIO } from './superadmin.repositorio.js';
import type { ServicioSuperadmin, SesionSuperadmin } from './superadmin.servicio.js';

const FALTAN_DATOS = 'Debes enviar tu correo, tu contraseña y el código de tu app autenticadora';

const esquemaLogin = z.object(
  {
    correo: z.string({ error: FALTAN_DATOS }).trim().min(1, FALTAN_DATOS).max(254, FALTAN_DATOS),
    // bcrypt solo usa los primeros 72 bytes; 128 deja margen para una clave larga
    clave: z.string({ error: FALTAN_DATOS }).min(1, FALTAN_DATOS).max(128, FALTAN_DATOS),
    codigo: z
      .string({ error: FALTAN_DATOS })
      .trim()
      .regex(/^\d{6}$/, 'El código de la app autenticadora debe tener 6 dígitos'),
  },
  { error: FALTAN_DATOS },
);

// Paginación de las listas: ?pagina=1&limite=25 (máximo 100)
const esquemaPagina = z.object({
  pagina: z.coerce
    .number({ error: 'La página debe ser un número entero desde 1' })
    .int('La página debe ser un número entero desde 1')
    .min(1, 'La página debe ser un número entero desde 1')
    .max(100_000, 'La página es demasiado grande')
    .default(1),
  limite: z.coerce
    .number({ error: 'El límite debe ser un número entero entre 1 y 100' })
    .int('El límite debe ser un número entero entre 1 y 100')
    .min(1, 'El límite debe ser un número entero entre 1 y 100')
    .max(100, 'El límite debe ser un número entero entre 1 y 100')
    .default(25),
});

// Un filtro vacío (?buscar=) cuenta como si no se hubiera enviado
const filtro = <T extends z.ZodType>(esquema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), esquema.optional());

const MENSAJE_ESTADO_NEGOCIO = `El estado debe ser uno de: ${ESTADOS_NEGOCIO.join(', ')}`;
const esquemaListaNegocios = esquemaPagina.extend({
  buscar: filtro(z.string().trim().max(100, 'La búsqueda admite máximo 100 caracteres')),
  estado: filtro(z.enum(ESTADOS_NEGOCIO, { error: MENSAJE_ESTADO_NEGOCIO })),
});

const MENSAJE_ESTADO_PQRS = `El estado debe ser uno de: ${ESTADOS_PQRS.join(', ')}`;
const esquemaListaPqrs = esquemaPagina.extend({
  estado: filtro(z.enum(ESTADOS_PQRS, { error: MENSAJE_ESTADO_PQRS })),
  tipo: filtro(z.enum(TIPOS_PQRS, { error: `El tipo debe ser uno de: ${TIPOS_PQRS.join(', ')}` })),
});

const esquemaListaActividad = esquemaPagina.extend({
  accion: filtro(z.string().trim().max(40, 'La acción admite máximo 40 caracteres')),
  empresaId: filtro(z.string().trim().max(64, 'Identificador de negocio inválido')),
  desde: filtro(fecha('desde')),
  hasta: filtro(fecha('hasta')),
});

const esquemaIdNegocio = esquemaId('Identificador de negocio inválido');
const esquemaRadicado = z.object({
  radicado: z
    .string({ error: 'Radicado inválido' })
    .trim()
    .min(1, 'Radicado inválido')
    .max(20, 'Radicado inválido')
    .transform((r) => r.toUpperCase()),
});

const motivoOpcional = z
  .string({ error: 'El motivo debe ser texto' })
  .trim()
  .max(300, 'El motivo admite máximo 300 caracteres')
  .optional()
  .transform((m) => m || undefined);

const esquemaPlan = z.object(
  {
    periodo: z.enum(['mensual', 'anual'], { error: 'El periodo debe ser "mensual" o "anual"' }),
    motivo: motivoOpcional,
  },
  { error: 'Envía el periodo del plan ("mensual" o "anual")' },
);

const esquemaExtender = z.object(
  {
    dias: z
      .number({ error: 'Los días deben ser un número entero entre 1 y 365' })
      .int('Los días deben ser un número entero entre 1 y 365')
      .min(1, 'Los días deben ser un número entero entre 1 y 365')
      .max(365, 'Los días deben ser un número entero entre 1 y 365'),
    motivo: motivoOpcional,
  },
  { error: 'Envía los días a extender en "dias"' },
);

// Suspender y reactivar siempre llevan motivo: queda en el registro de actividad
const esquemaMotivo = z.object({ motivo: texto('motivo', 300) }, { error: obligatorio('motivo') });

const esquemaResponder = z.object(
  {
    estado: z.enum(ESTADOS_PQRS, { error: MENSAJE_ESTADO_PQRS }),
    respuesta: z
      .string({ error: 'La respuesta debe ser texto' })
      .trim()
      .max(2000, 'El campo "respuesta" admite máximo 2000 caracteres')
      .optional()
      .transform((r) => r || undefined),
  },
  { error: 'Envía el nuevo estado de la PQRS en "estado"' },
);

const MENSAJE_ACTIVA = 'El campo "activa" debe ser true o false';
const esquemaCrearCategoria = z.object({ nombre: texto('nombre', 60) }, { error: 'Envía el nombre de la categoría en "nombre"' });
const esquemaEditarCategoria = z
  .object(
    { nombre: texto('nombre', 60).optional(), activa: z.boolean({ error: MENSAJE_ACTIVA }).optional() },
    { error: 'Envía el nombre o el estado de la categoría' },
  )
  .refine((d) => d.nombre !== undefined || d.activa !== undefined, { error: 'Envía al menos un dato para actualizar' });

const sesionDe = (res: { locals: Record<string, unknown> }): SesionSuperadmin => {
  const sesion = res.locals.superadmin as SesionSuperadmin | undefined;
  if (!sesion) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
  return sesion;
};

// Panel del dueño de la plataforma. Solo el token del superadmin (login con segundo paso) sirve aquí.
export const crearRutasSuperadmin = (
  servicio: ServicioSuperadmin,
  categorias: ServicioCategorias,
  limitadores: Limitadores,
) => {
  const rutas = Router();

  // Estas respuestas traen datos de toda la plataforma: que nadie las guarde en caché
  rutas.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Solo cuentan los intentos fallidos (límite por IP); además la cuenta se bloquea tras 5 fallos seguidos
  rutas.post('/login', limitadores.login, async (req, res) => {
    res.json(await servicio.iniciarSesion(parsear(esquemaLogin, req.body), req.ip));
  });

  const requerirSuperadmin: RequestHandler = async (req, res, next) => {
    res.locals.superadmin = await servicio.validarSesion(tokenDe(req));
    next();
  };
  rutas.use(requerirSuperadmin);

  // Invalida la sesión en el servidor (el token ya no sirve, aunque no haya vencido)
  rutas.post('/logout', async (_req, res) => {
    res.json(await servicio.cerrarSesion(sesionDe(res)));
  });

  rutas.get('/resumen', async (_req, res) => {
    res.json(await servicio.resumen());
  });

  rutas.get('/estadisticas', async (_req, res) => {
    res.json(await servicio.estadisticas());
  });

  rutas.get('/ingresos', async (_req, res) => {
    res.json(await servicio.ingresos());
  });

  rutas.get('/negocios', async (req, res) => {
    const { pagina, limite, ...filtros } = parsear(esquemaListaNegocios, req.query);
    res.json(await servicio.listarNegocios(filtros, { pagina, limite }));
  });

  rutas.get('/negocios/:id', async (req, res) => {
    res.json(await servicio.detalleNegocio(parsear(esquemaIdNegocio, req.params).id));
  });

  rutas.post('/negocios/:id/plan', async (req, res) => {
    const { id } = parsear(esquemaIdNegocio, req.params);
    res.json(await servicio.activarPlan(sesionDe(res), id, parsear(esquemaPlan, req.body)));
  });

  rutas.post('/negocios/:id/extender-prueba', async (req, res) => {
    const { id } = parsear(esquemaIdNegocio, req.params);
    res.json(await servicio.extenderPrueba(sesionDe(res), id, parsear(esquemaExtender, req.body)));
  });

  rutas.post('/negocios/:id/suspender', async (req, res) => {
    const { id } = parsear(esquemaIdNegocio, req.params);
    res.json(await servicio.suspender(sesionDe(res), id, parsear(esquemaMotivo, req.body).motivo));
  });

  rutas.post('/negocios/:id/reactivar', async (req, res) => {
    const { id } = parsear(esquemaIdNegocio, req.params);
    res.json(await servicio.reactivar(sesionDe(res), id, parsear(esquemaMotivo, req.body).motivo));
  });

  rutas.get('/pqrs', async (req, res) => {
    const { pagina, limite, ...filtros } = parsear(esquemaListaPqrs, req.query);
    res.json(await servicio.listarPqrs(filtros, { pagina, limite }));
  });

  rutas.get('/pqrs/:radicado', async (req, res) => {
    res.json(await servicio.detallePqrs(parsear(esquemaRadicado, req.params).radicado));
  });

  rutas.patch('/pqrs/:radicado', async (req, res) => {
    const { radicado } = parsear(esquemaRadicado, req.params);
    res.json(await servicio.responderPqrs(sesionDe(res), radicado, parsear(esquemaResponder, req.body)));
  });

  // Categorías de negocio: solo el superadmin las crea, edita o desactiva (nunca se borran)
  rutas.get('/categorias', async (_req, res) => {
    res.json(await categorias.listarTodas());
  });

  rutas.post('/categorias', async (req, res) => {
    res.status(201).json(await categorias.crear(sesionDe(res), parsear(esquemaCrearCategoria, req.body).nombre));
  });

  rutas.patch('/categorias/:id', async (req, res) => {
    const { id } = parsear(esquemaId('Identificador de categoría inválido'), req.params);
    res.json(await categorias.actualizar(sesionDe(res), id, parsear(esquemaEditarCategoria, req.body)));
  });

  rutas.get('/actividad', async (req, res) => {
    const { pagina, limite, ...filtros } = parsear(esquemaListaActividad, req.query);
    res.json(await servicio.actividad(filtros, { pagina, limite }));
  });

  return rutas;
};
