import { type RequestHandler, Router } from 'express';
import { z } from 'zod';
import { errores } from '../../shared/errores.js';
import { esquemaId, fecha, obligatorio, texto } from '../../shared/http/esquemas.js';
import { ipDe } from '../../shared/http/ip.js';
import type { Limitadores } from '../../shared/http/limitadores.js';
import { parsear } from '../../shared/http/validacion.js';
import { tokenDe } from '../auth/guardias.js';
import { normalizarTelefono, TELEFONO_INVALIDO } from '../../shared/telefonos.js';
import type { ServicioFormasPago, TipoQr } from '../pagos/formasPago.servicio.js';
import type { ServicioPagosManuales } from '../pagos/pagos.manual.servicio.js';
import { recibirQr } from '../pagos/recibirQr.js';
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

// ---- Pagos manuales (Nequi, llave Bre-B y código QR) ----

const MENSAJE_BOOLEANO = (campo: string) => `El campo "${campo}" debe ser true o false`;
const esquemaFormasPago = z
  .object(
    {
      titular: texto('titular', 100).optional(),
      whatsapp: z.string({ error: 'El campo "whatsapp" debe ser texto' }).trim().min(1, obligatorio('whatsapp')).max(25, TELEFONO_INVALIDO).optional(),
      indicativo: z.string().trim().max(4).optional(),
      nequiNumero: z
        .union([z.string().transform((n) => n.replace(/[\s-]/g, '')).pipe(z.string().regex(/^3\d{9}$/, 'El número de Nequi debe ser un celular colombiano de 10 dígitos (ej. 3001234567)')), z.null()], {
          error: 'El número de Nequi debe ser un celular colombiano de 10 dígitos (ej. 3001234567)',
        })
        .optional(),
      llaveBreb: z
        .union([z.string().trim().min(3, 'La llave Bre-B debe tener entre 3 y 60 caracteres').max(60, 'La llave Bre-B debe tener entre 3 y 60 caracteres').regex(/^[^\u0000-\u001f\u007f]+$/, 'La llave Bre-B tiene caracteres no permitidos'), z.null()], {
          error: 'La llave Bre-B debe tener entre 3 y 60 caracteres',
        })
        .optional(),
      nequiActivo: z.boolean({ error: MENSAJE_BOOLEANO('nequiActivo') }).optional(),
      llaveBrebActiva: z.boolean({ error: MENSAJE_BOOLEANO('llaveBrebActiva') }).optional(),
      qrActivo: z.boolean({ error: MENSAJE_BOOLEANO('qrActivo') }).optional(),
    },
    { error: 'Envía los datos de las formas de pago' },
  )
  .transform((d, ctx) => {
    const { indicativo, whatsapp, ...resto } = d;
    if (whatsapp === undefined) return resto;
    const normalizado = normalizarTelefono(whatsapp, indicativo);
    if (!normalizado) {
      ctx.addIssue({ code: 'custom', message: TELEFONO_INVALIDO, path: ['whatsapp'] });
      return z.NEVER;
    }
    return { ...resto, whatsapp: normalizado.telefono };
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), { error: 'Envía al menos un dato para actualizar' });

const esquemaTipoQr = z.object({ tipo: z.enum(['nequi', 'breb'], { error: 'El código QR debe ser "nequi" o "breb"' }) });

const ESTADOS_ORDEN = ['pendiente', 'aprobada', 'rechazada', 'anulada'] as const;
const esquemaListaOrdenes = esquemaPagina.extend({
  estado: filtro(z.enum(ESTADOS_ORDEN, { error: `El estado debe ser uno de: ${ESTADOS_ORDEN.join(', ')}` })).default('pendiente'),
});
const esquemaReferencia = z.object({
  referencia: z.string({ error: 'Referencia inválida' }).trim().min(1, 'Referencia inválida').max(40, 'Referencia inválida').transform((r) => r.toUpperCase()),
});
const esquemaAprobar = z.object({ motivo: motivoOpcional }).optional();
const esquemaRechazar = z.object({ motivo: texto('motivo', 300) }, { error: obligatorio('motivo') });

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
  pagos: { formas: ServicioFormasPago; ordenes: ServicioPagosManuales },
) => {
  const rutas = Router();

  // Estas respuestas traen datos de toda la plataforma: que nadie las guarde en caché
  rutas.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Solo cuentan los intentos fallidos (límite por IP, propio de esta ruta); además se bloquea la pareja cuenta + IP
  // tras varios fallos seguidos (ver iniciarSesion), así nadie puede dejar fuera al dueño desde otra conexión
  rutas.post('/login', limitadores.loginSuperadmin, async (req, res) => {
    res.json(await servicio.iniciarSesion(parsear(esquemaLogin, req.body), ipDe(req)));
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

  // Pagos manuales: solo el superadmin configura las formas de pago y aprueba o rechaza las órdenes
  rutas.get('/pagos/formas-pago', async (_req, res) => {
    res.json(await pagos.formas.ver());
  });

  rutas.patch('/pagos/formas-pago', limitadores.revisionPagos, async (req, res) => {
    res.json(await pagos.formas.guardar(sesionDe(res), parsear(esquemaFormasPago, req.body)));
  });

  rutas.put('/pagos/formas-pago/qr/:tipo', limitadores.revisionPagos, recibirQr, async (req, res) => {
    const { tipo } = parsear(esquemaTipoQr, req.params);
    res.json(await pagos.formas.guardarQr(sesionDe(res), tipo as TipoQr, req.file!.buffer));
  });

  rutas.delete('/pagos/formas-pago/qr/:tipo', limitadores.revisionPagos, async (req, res) => {
    const { tipo } = parsear(esquemaTipoQr, req.params);
    res.json(await pagos.formas.borrarQr(sesionDe(res), tipo as TipoQr));
  });

  rutas.get('/pagos/formas-pago/qr/:tipo', async (req, res) => {
    const { tipo } = parsear(esquemaTipoQr, req.params);
    const { imagen, tipo: mime } = await pagos.formas.imagenQr(tipo as TipoQr, false);
    res.set({ 'Content-Type': mime, 'Content-Disposition': 'inline' }).send(imagen);
  });

  rutas.get('/pagos/ordenes', async (req, res) => {
    const { pagina, limite, estado } = parsear(esquemaListaOrdenes, req.query);
    const { total, datos } = await pagos.ordenes.listarParaSuperadmin({ estado, limite, desplazamiento: (pagina - 1) * limite });
    res.json({ total, pagina, limite, datos });
  });

  rutas.post('/pagos/ordenes/:referencia/aprobar', limitadores.revisionPagos, async (req, res) => {
    const { referencia } = parsear(esquemaReferencia, req.params);
    res.json(await pagos.ordenes.aprobar(sesionDe(res), referencia, parsear(esquemaAprobar, req.body)?.motivo));
  });

  rutas.post('/pagos/ordenes/:referencia/rechazar', limitadores.revisionPagos, async (req, res) => {
    const { referencia } = parsear(esquemaReferencia, req.params);
    res.json(await pagos.ordenes.rechazar(sesionDe(res), referencia, parsear(esquemaRechazar, req.body).motivo));
  });

  rutas.get('/actividad', async (req, res) => {
    const { pagina, limite, ...filtros } = parsear(esquemaListaActividad, req.query);
    res.json(await servicio.actividad(filtros, { pagina, limite }));
  });

  return rutas;
};
