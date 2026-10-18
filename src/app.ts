import express, { type Express } from 'express';
import helmet from 'helmet';
import type pg from 'pg';
import type { Entorno } from './config/entorno.js';
import { crearRutasAuth } from './modules/auth/auth.rutas.js';
import { crearServicioAuth } from './modules/auth/auth.servicio.js';
import { crearGuardias } from './modules/auth/guardias.js';
import { crearServicioTokens } from './modules/auth/tokens.js';
import { crearRutasCitas } from './modules/citas/citas.rutas.js';
import { crearServicioCitas } from './modules/citas/citas.servicio.js';
import { crearRutasCuentas } from './modules/cuentas/cuentas.rutas.js';
import { crearServicioCuentas } from './modules/cuentas/cuentas.servicio.js';
import { crearGuardiasCuenta } from './modules/cuentas/cuentas.guardias.js';
import { crearRutasAdminEmpresa, crearRutasEmpresas } from './modules/empresas/empresas.rutas.js';
import { crearServicioEmpresas } from './modules/empresas/empresas.servicio.js';
import { crearGuardiaSuscripcion } from './modules/empresas/suscripcion.js';
import { crearCors } from './shared/http/cors.js';
import { type ConfigLimites, crearLimitadores, LIMITES_POR_DEFECTO } from './shared/http/limitadores.js';
import { manejadorErrores, rutaNoEncontrada } from './shared/http/manejadorErrores.js';
import { registro } from './shared/registro.js';

export type Dependencias = {
  pool: pg.Pool;
  entorno: Entorno;
  limites?: ConfigLimites;
};

// Punto de composición: aquí se crean los servicios y se conectan con sus rutas.
// Recibe sus dependencias para poder probar la app con otra base de datos.
export const crearApp = ({ pool, entorno, limites = LIMITES_POR_DEFECTO }: Dependencias): Express => {
  const tokens = crearServicioTokens(entorno.JWT_SECRET, entorno.JWT_EXPIRA_EN);
  const auth = crearServicioAuth({ pool, tokens });
  const guardias = crearGuardias(auth);
  const cuentas = crearServicioCuentas({ pool, tokens });
  const guardiasCuenta = crearGuardiasCuenta(cuentas);
  const suscripcion = crearGuardiaSuscripcion({ pool });
  const empresas = crearServicioEmpresas({ pool });
  const limitadores = crearLimitadores(limites);

  const app = express();
  app.set('trust proxy', entorno.TRUST_PROXY);
  app.use(helmet());
  app.use(crearCors(entorno));
  app.use(express.json({ limit: '10kb' }));
  app.use('/api', limitadores.general);

  // Comprobación de salud (monitoreo y la app en desarrollo)
  app.get('/api/saludo', async (_req, res) => {
    try {
      const { rows } = await pool.query<{ now: Date }>('SELECT NOW()');
      res.json({
        mensaje: '¡Servidor Backend funcionando correctamente! 🚀',
        horaBaseDatos: rows[0].now,
      });
    } catch (error) {
      registro.error('salud_sin_base_de_datos', { mensaje: (error as Error).message });
      res.status(500).json({ error: 'Error de conexión con la base de datos' });
    }
  });

  app.use('/api/v1/auth', crearRutasAuth(auth, limitadores));
  app.use('/api/v1/cuentas', crearRutasCuentas(cuentas, limitadores));
  app.use('/api/v1/empresas', crearRutasEmpresas(empresas, guardias, limitadores));
  app.use('/api/v1/admin/empresa', crearRutasAdminEmpresa(empresas, guardiasCuenta, suscripcion));
  app.use('/api/v1/citas', crearRutasCitas(crearServicioCitas({ pool }), guardias, suscripcion, limitadores));

  app.use(rutaNoEncontrada);
  app.use(manejadorErrores);
  return app;
};
