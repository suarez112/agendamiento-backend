import express, { type Express } from 'express';
import helmet from 'helmet';
import type pg from 'pg';
import type { Entorno } from './config/entorno.js';
import { crearRutasAcceso } from './modules/auth/acceso.js';
import { crearRutasAuth } from './modules/auth/auth.rutas.js';
import { crearServicioAuth } from './modules/auth/auth.servicio.js';
import { crearGuardias } from './modules/auth/guardias.js';
import { crearPermisos } from './modules/auth/permisos.js';
import { crearServicioIntentos } from './modules/auth/intentos.js';
import { crearRutasLogout } from './modules/auth/logout.js';
import { crearServicioTokens } from './modules/auth/tokens.js';
import { crearRutasBloqueos } from './modules/bloqueos/bloqueos.rutas.js';
import { crearServicioBloqueos } from './modules/bloqueos/bloqueos.servicio.js';
import { crearRutasCategorias } from './modules/categorias/categorias.rutas.js';
import { crearServicioCategorias } from './modules/categorias/categorias.servicio.js';
import { crearRutasCartera } from './modules/cartera/cartera.rutas.js';
import { crearServicioCartera } from './modules/cartera/cartera.servicio.js';
import { crearRutasReportes } from './modules/reportes/reportes.rutas.js';
import { crearServicioReportes } from './modules/reportes/reportes.servicio.js';
import { crearRutasCitas } from './modules/citas/citas.rutas.js';
import { crearServicioCitas } from './modules/citas/citas.servicio.js';
import { crearRutasClientes } from './modules/clientes/clientes.rutas.js';
import { crearServicioClientes } from './modules/clientes/clientes.servicio.js';
import { crearRutasCuentas } from './modules/cuentas/cuentas.rutas.js';
import { crearServicioCuentas } from './modules/cuentas/cuentas.servicio.js';
import { crearServicioEliminacion } from './modules/cuentas/eliminacion.servicio.js';
import { crearServicioRecuperacion } from './modules/cuentas/recuperacion.servicio.js';
import { crearGuardiasCuenta } from './modules/cuentas/cuentas.guardias.js';
import { crearRutasAdminEmpresa, crearRutasEmpresas } from './modules/empresas/empresas.rutas.js';
import { crearServicioEmpresas } from './modules/empresas/empresas.servicio.js';
import { crearServicioExportacion } from './modules/reportes/exportacion.js';
import { crearServicioGuia } from './modules/empresas/guia.js';
import { crearAlmacenesFotos, crearUrlBase, PREFIJO_SUBIDAS } from './modules/empresas/fotos.js';
import { crearGuardiaSuscripcion } from './modules/empresas/suscripcion.js';
import { crearRutasEquipo } from './modules/equipo/equipo.rutas.js';
import { crearServicioEquipo } from './modules/equipo/equipo.servicio.js';
import { crearRutasLegal } from './modules/legal/legal.js';
import { crearResolverTitular, crearRutasDispositivos } from './modules/notificaciones/dispositivos.rutas.js';
import { crearRutasNotificaciones } from './modules/notificaciones/notificaciones.rutas.js';
import { crearServicioNotificaciones } from './modules/notificaciones/notificaciones.servicio.js';
import { crearRutasMiCuenta, crearServicioMiCuenta } from './modules/micuenta/micuenta.rutas.js';
import { crearRutasPqrs } from './modules/pqrs/pqrs.rutas.js';
import { crearServicioPqrs } from './modules/pqrs/pqrs.servicio.js';
import { crearProveedorDePago } from './modules/pagos/proveedores.js';
import { crearRutasPagos } from './modules/pagos/pagos.rutas.js';
import { crearServicioPagos } from './modules/pagos/pagos.servicio.js';
import { crearRutasPlanes } from './modules/planes/planes.js';
import { crearRutasFunciones, crearServicioFunciones } from './modules/planes/funciones.js';
import { crearRutasProductos } from './modules/productos/productos.rutas.js';
import { crearServicioProductos } from './modules/productos/productos.servicio.js';
import { crearRutasServicios } from './modules/servicios/servicios.rutas.js';
import { crearServicioServicios } from './modules/servicios/servicios.servicio.js';
import { crearRutasSuperadmin } from './modules/superadmin/superadmin.rutas.js';
import { crearServicioSuperadmin } from './modules/superadmin/superadmin.servicio.js';
import { crearRutasUbicaciones } from './modules/ubicaciones/ubicaciones.js';
import type { ProveedorPago } from './modules/pagos/proveedor.js';
import { crearEnviadorCorreo, type EnviadorCorreo } from './shared/correo.js';
import { crearEnviadorPush, type EnviadorPush } from './shared/push.js';
import { crearCors } from './shared/http/cors.js';
import { AJUSTE_CLOUDFLARE } from './shared/http/ip.js';
import { type ConfigLimites, crearLimitadores, LIMITES_POR_DEFECTO } from './shared/http/limitadores.js';
import { manejadorErrores, rutaNoEncontrada } from './shared/http/manejadorErrores.js';

// Un bloqueo de cuenta por intentos fallidos nunca dura más que esto, por muchos bloqueos seguidos que lleve
const TOPE_BLOQUEO_CUENTA_MS = 4 * 60 * 60_000;

export type Dependencias = {
  pool: pg.Pool;
  entorno: Entorno;
  limites?: ConfigLimites;
  // Por defecto: imprime en la consola (desarrollo) o solo avisa en el log (producción sin proveedor)
  correo?: EnviadorCorreo;
  // Por defecto: Expo Push (en las pruebas no envía nada)
  push?: EnviadorPush;
  // Por defecto: el que dice el entorno (simulado fuera de producción; wompi con sus llaves). undefined = sin pagos
  // null = sin pagos en línea
  proveedorPago?: ProveedorPago | null;
};

// Punto de composición: aquí se crean los servicios y se conectan con sus rutas.
// Recibe sus dependencias para poder probar la app con otra base de datos.
export const crearApp = ({
  pool,
  entorno,
  limites = LIMITES_POR_DEFECTO,
  correo = crearEnviadorCorreo(entorno.NODE_ENV),
  push = crearEnviadorPush(entorno.NODE_ENV, entorno.EXPO_ACCESS_TOKEN),
  proveedorPago = crearProveedorDePago(entorno, pool) ?? null,
}: Dependencias): Express => {
  const tokens = crearServicioTokens(entorno.JWT_SECRET, entorno.JWT_EXPIRA_EN);
  const auth = crearServicioAuth({ pool, tokens });
  const guardias = crearGuardias(auth);
  const categorias = crearServicioCategorias({ pool });
  const cuentas = crearServicioCuentas({ pool, tokens, categorias, enlaceBase: entorno.ENLACE_PUBLICO_BASE });
  const guardiasCuenta = crearGuardiasCuenta(cuentas);
  const suscripcion = crearGuardiaSuscripcion({ pool });
  const permisos = crearPermisos(guardias, suscripcion);
  const fotos = crearAlmacenesFotos(entorno.CARPETA_SUBIDAS);
  const urlBase = crearUrlBase(entorno.URL_PUBLICA);
  const empresas = crearServicioEmpresas({ pool, fotos: fotos.empresas, enlaceBase: entorno.ENLACE_PUBLICO_BASE });
  const limitadores = crearLimitadores(limites);
  // Contadores de fallos de inicio de sesión guardados en la base de datos: uno por cuenta y otro, más estricto, por
  // cuenta + IP para el superadmin
  const intentosPorCuenta = crearServicioIntentos(pool, {
    max: limites.fallosPorCuenta,
    ventanaMs: limites.ventanaMs,
    bloqueoBaseMs: limites.bloqueoCuentaMs,
    bloqueoMaxMs: TOPE_BLOQUEO_CUENTA_MS,
  });
  const recuperacion = crearServicioRecuperacion({ pool, secreto: entorno.RECUPERACION_SECRET, correo, intentos: intentosPorCuenta });
  const intentosSuperadmin = crearServicioIntentos(pool, {
    max: limites.fallosSuperadmin,
    ventanaMs: limites.ventanaMs,
    bloqueoBaseMs: limites.bloqueoCuentaMs,
    bloqueoMaxMs: TOPE_BLOQUEO_CUENTA_MS,
  });
  const notificaciones = crearServicioNotificaciones({ pool, push });
  const funciones = crearServicioFunciones({ pool });
  const servicioCartera = crearServicioCartera({ pool });
  const servicioReportes = crearServicioReportes({ pool });

  const app = express();
  app.set('trust proxy', entorno.TRUST_PROXY);
  app.set(AJUSTE_CLOUDFLARE, entorno.DETRAS_DE_CLOUDFLARE);
  app.use(helmet());
  app.use(crearCors(entorno));
  app.use(express.json({ limit: '10kb' }));
  app.use('/api', limitadores.general);

  // Fotos subidas (empresas, equipo y productos). Los nombres son aleatorios y nunca se reutilizan, así que se
  // pueden guardar en caché. Cross-origin permite mostrarlas en la app web.
  app.use(
    PREFIJO_SUBIDAS,
    express.static(fotos.carpeta, {
      index: false,
      dotfiles: 'deny',
      redirect: false,
      maxAge: '30d',
      immutable: true,
      setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
    }),
  );

  // Login único (administradora o personal); los dos logins de abajo siguen funcionando
  app.use('/api/v1/login', crearRutasAcceso(auth, cuentas, limitadores, intentosPorCuenta));
  app.use('/api/v1/auth', crearRutasAuth(auth, limitadores, intentosPorCuenta));
  app.use('/api/v1/cuentas', crearRutasCuentas(cuentas, recuperacion, crearServicioEliminacion({ pool, fotos: fotos.barberos }), guardiasCuenta, limitadores, intentosPorCuenta));
  app.use('/api/v1/ubicaciones', crearRutasUbicaciones());
  app.use('/api/v1/planes', crearRutasPlanes());
  // Pagos de la suscripción con pasarela (administradores) y webhook de la pasarela
  app.use('/api/v1/pagos', crearRutasPagos(crearServicioPagos({ pool, proveedor: proveedorPago ?? undefined, urlPagos: entorno.URL_PAGOS }), guardias, proveedorPago ?? undefined));
  // Funciones que incluye el plan del negocio de la sesión
  app.use('/api/v1/funciones', crearRutasFunciones(funciones, guardias));
  app.use('/api/v1/categorias', crearRutasCategorias(categorias));
  app.use('/api/v1/pqrs', crearRutasPqrs(crearServicioPqrs({ pool }), cuentas, guardiasCuenta, limitadores));
  // Panel del dueño de la plataforma: sesión propia, con verificación en dos pasos
  app.use(
    '/api/v1/superadmin',
    crearRutasSuperadmin(crearServicioSuperadmin({ pool, tokens, secreto: entorno.TOTP_SECRET, intentos: intentosSuperadmin }), categorias, limitadores),
  );
  // Celulares con sesión para recibir notificaciones push
  const titularDe = crearResolverTitular(auth, cuentas, tokens);
  app.use('/api/v1/legal', crearRutasLegal({ pool, titularDe }));
  // Cerrar sesión en el servidor (cualquier sesión)
  app.use('/api/v1/logout', crearRutasLogout(pool, titularDe));
  app.use('/api/v1/dispositivos', crearRutasDispositivos(notificaciones, titularDe));
  // Centro de notificaciones dentro de la app (cualquier sesión)
  app.use('/api/v1/notificaciones', crearRutasNotificaciones(notificaciones, titularDe));
  // Cuenta del cliente registrado: negocios guardados y sus citas
  const servicioCitas = crearServicioCitas({ pool, notificaciones, maxPendientes: entorno.MAX_CITAS_PENDIENTES });
  app.use(
    '/api/v1/mi-cuenta',
    crearRutasMiCuenta(crearServicioMiCuenta({ pool, notificaciones, citas: servicioCitas }), guardiasCuenta, limitadores, urlBase),
  );
  app.use('/api/v1/empresas', crearRutasEmpresas(empresas, guardias, limitadores, urlBase));
  app.use('/api/v1/admin/empresa', crearRutasAdminEmpresa(empresas, guardias, urlBase, crearServicioGuia({ pool, enlaceBase: entorno.ENLACE_PUBLICO_BASE })));
  app.use('/api/v1/citas', crearRutasCitas(servicioCitas, guardias, suscripcion, limitadores, cuentas));
  // Gestión del negocio: personal (barberos) o la cuenta del administrador de la empresa
  app.use('/api/v1/clientes', crearRutasClientes(crearServicioClientes({ pool }), permisos));
  app.use('/api/v1/equipo', crearRutasEquipo(crearServicioEquipo({ pool, fotos: fotos.barberos, tokens }), permisos, urlBase, funciones));
  app.use('/api/v1/servicios', crearRutasServicios(crearServicioServicios({ pool }), permisos));
  app.use(
    '/api/v1/productos',
    crearRutasProductos(crearServicioProductos({ pool, fotos: fotos.productos }), permisos, limitadores, urlBase),
  );
  app.use('/api/v1/bloqueos', crearRutasBloqueos(crearServicioBloqueos({ pool }), permisos));
  app.use('/api/v1/cartera', crearRutasCartera(servicioCartera, permisos, funciones));
  // Reportes para administradores: ocupación, servicios más rentables y demanda
  app.use('/api/v1/reportes', crearRutasReportes(servicioReportes, crearServicioExportacion({ pool, reportes: servicioReportes, cartera: servicioCartera }), permisos, funciones));

  app.use(rutaNoEncontrada);
  app.use(manejadorErrores);
  return app;
};
