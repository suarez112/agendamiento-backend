import { type ChildProcess, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import type pg from 'pg';
import { crearApp } from '../../src/app.js';
import { cifrarContrasena } from '../../src/modules/auth/contrasenas.js';
import { cifrarSecreto, codigoTotp, generarSecretoTotp } from '../../src/modules/superadmin/totp.js';
import { cargarEntorno, type Entorno } from '../../src/config/entorno.js';
import type { ProveedorPago } from '../../src/modules/pagos/proveedor.js';
import type { ConfigLimites } from '../../src/shared/http/limitadores.js';
import { type BaseDePrueba, crearBaseDePrueba, FECHA_FUTURA } from './baseDePrueba.js';
import { leerConfigPruebas } from './configuracionPruebas.js';

export const SECRETO_PRUEBAS = 'secreto-de-pruebas-con-mas-de-32-caracteres';
// Un secreto distinto para cada uso (B-4): las sesiones, los códigos de recuperación y el segundo paso del superadmin
export const SECRETO_RECUPERACION_PRUEBAS = 'secreto-de-recuperacion-de-pruebas-1234567890';
export const SECRETO_TOTP_PRUEBAS = 'secreto-del-segundo-paso-de-pruebas-1234567';

// Límites altos para que las pruebas no choquen con ellos (salvo la que los prueba)
const LIMITES_PRUEBA: ConfigLimites = {
  ventanaMs: 60_000,
  ventanaLargaMs: 60_000,
  general: 10_000,
  loginUnico: 1_000,
  loginPersonal: 1_000,
  loginCuentas: 1_000,
  eliminarCuenta: 1_000,
  loginSuperadmin: 1_000,
  codigoNegocio: 1_000,
  reservas: 1_000,
  reservasCreadas: 1_000,
  registro: 1_000,
  recuperacion: 1_000,
  recuperacionPorCorreo: 1_000,
  pqrs: 1_000,
  estadoPago: 1_000,
  ordenesPago: 1_000,
  formasPago: 1_000,
  revisionPagos: 1_000,
  fallosPorCuenta: 1_000,
  fallosSuperadmin: 1_000,
  bloqueoCuentaMs: 60_000,
};

export type Contexto = { url: string; pool: pg.Pool; cerrar: () => Promise<void> };

// proveedorPago: 'ausente' fuerza una app sin pagos; sin la clave se usa el del entorno (simulado en pruebas)
type Opciones = { limites?: Partial<ConfigLimites>; entorno?: Partial<Entorno>; proveedorPago?: ProveedorPago | 'ausente' };

const puertoLibre = () =>
  new Promise<number>((resolver) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolver(port));
    });
  });

// PRUEBA_BASELINE_DIR=<copia del código anterior> ejecuta las mismas pruebas
// contra la versión vieja del servidor (evidencia RED). Sin esa variable se
// prueba el código actual dentro del mismo proceso.
export const iniciar = async (opciones: Opciones = {}): Promise<Contexto> => {
  const baselineDir = process.env.PRUEBA_BASELINE_DIR;
  const base: BaseDePrueba = await crearBaseDePrueba(baselineDir ? { hasta: '001' } : {});
  // Servidor y credenciales de pruebas: nada de lo que se arma aquí apunta a la base de desarrollo
  const prueba = leerConfigPruebas();
  const datosDb = { DB_HOST: prueba.host, DB_PORT: String(prueba.port), DB_USER: prueba.user, DB_PASSWORD: prueba.password };

  if (baselineDir) {
    const puerto = await puertoLibre();
    const proceso: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: baselineDir,
      env: { ...process.env, ...datosDb, DB_NAME: base.nombre, PORT: String(puerto), JWT_SECRET: SECRETO_PRUEBAS },
      stdio: 'ignore',
    });
    const url = `http://127.0.0.1:${puerto}`;
    for (let intento = 0; intento < 100; intento++) {
      try {
        if ((await fetch(`${url}/api/saludo`)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return {
      url,
      pool: base.pool,
      cerrar: async () => {
        proceso.kill();
        await base.destruir();
      },
    };
  }

  // El proveedor de pago lo deciden las pruebas (por defecto, el simulado), no el .env de quien las corre
  const { PROVEEDOR_PAGO: _delEnv, ...procesoSinProveedor } = process.env;
  const entorno: Entorno = {
    ...cargarEntorno({ ...procesoSinProveedor, ...datosDb, DB_NAME: base.nombre, NODE_ENV: 'test',
      JWT_SECRET: SECRETO_PRUEBAS,
      RECUPERACION_SECRET: SECRETO_RECUPERACION_PRUEBAS,
      TOTP_SECRET: SECRETO_TOTP_PRUEBAS,
    }),
    DB_NAME: base.nombre,
    ...opciones.entorno,
  };
  const app = crearApp({
    pool: base.pool,
    entorno,
    limites: { ...LIMITES_PRUEBA, ...opciones.limites },
    ...(opciones.proveedorPago ? { proveedorPago: opciones.proveedorPago === 'ausente' ? null : opciones.proveedorPago } : {}),
  });
  const servidor: Server = await new Promise((resolver) => {
    const s = app.listen(0, '127.0.0.1', () => resolver(s as unknown as Server));
  });
  const { port } = servidor.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    pool: base.pool,
    cerrar: async () => {
      await new Promise((r) => servidor.close(r));
      await base.destruir();
    },
  };
};

type Peticion = {
  method?: string;
  body?: unknown;
  cuerpoCrudo?: string;
  token?: string;
  headers?: Record<string, string>;
};

export type Respuesta = { estado: number; json: any; texto: string; headers: Headers };

export const pedir = async (ctx: Contexto, ruta: string, p: Peticion = {}): Promise<Respuesta> => {
  const headers: Record<string, string> = { ...p.headers };
  if (p.body !== undefined || p.cuerpoCrudo !== undefined) headers['Content-Type'] ??= 'application/json';
  if (p.token) headers.Authorization = `Bearer ${p.token}`;
  const r = await fetch(`${ctx.url}${ruta}`, {
    method: p.method ?? 'GET',
    headers,
    body: p.cuerpoCrudo ?? (p.body !== undefined ? JSON.stringify(p.body) : undefined),
  });
  const texto = await r.text();
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    json = undefined;
  }
  return { estado: r.status, json, texto, headers: r.headers };
};

export const iniciarSesion = async (ctx: Contexto, usuario: string, clave: string): Promise<string> => {
  const r = await pedir(ctx, '/api/v1/auth/login', { method: 'POST', body: { usuario, clave } });
  if (r.estado !== 200) throw new Error(`Login de ${usuario} falló con ${r.estado}`);
  return r.json.token;
};

// Contraseñas que cumplen la regla vigente (mayúscula, minúscula, número y carácter especial)
export const CLAVE_ADMIN = 'Clave-segura-123';
export const CLAVE_CLIENTE = 'Mi-clave-123';

// Teléfono colombiano válido (E.164: +57310NNNNNNN) distinto para cada n
export const telefonoValido = (n: number) => `310${String(n).padStart(7, '0')}`;
export const e164 = (n: number) => `+57${telefonoValido(n)}`;

// Horario de los 7 días: domingo cerrado y de lunes a sábado de apertura a cierre
export const horarioValido = (apertura = '08:00', cierre = '19:00') =>
  [0, 1, 2, 3, 4, 5, 6].map((dia) =>
    dia === 0 ? { dia, abierto: false } : { dia, abierto: true, apertura, cierre },
  );

let secuencia = 0;

// Datos completos para registrar una empresa con su administradora. El código del negocio y el
// usuario cambian en cada llamada (son únicos); el correo es el mismo salvo que se indique otro.
export const empresaValida = (cambios: Record<string, unknown> = {}) => {
  const n = ++secuencia;
  return {
    nombre: 'Barbería Central',
    categoria: 'Barbería',
    codigoAcceso: `CENTRAL${n}`,
    direccion: 'Calle 10 # 20-30',
    departamento: 'Santander',
    ciudad: 'Bucaramanga',
    horario: horarioValido(),
    nombreAdministradora: 'Ana Pérez',
    numeroEmpleados: 4,
    logoUrl: 'https://cdn.central.co/logo.png',
    correo: 'admin@central.co',
    usuario: `ana.perez${n}`,
    clave: CLAVE_ADMIN,
    aceptaPoliticaDatos: true,
    aceptaTerminos: true,
    ...cambios,
  };
};

export const registrarEmpresa = (ctx: Contexto, cambios: Record<string, unknown> = {}) =>
  pedir(ctx, '/api/v1/cuentas/registro/empresa', { method: 'POST', body: empresaValida(cambios) });

// Cuenta de cliente. El teléfono cambia en cada llamada (es único entre las cuentas de cliente).
export const registrarCliente = (ctx: Contexto, correo: unknown, clave: unknown, cambios: Record<string, unknown> = {}) =>
  pedir(ctx, '/api/v1/cuentas/registro/cliente', {
    method: 'POST',
    body: {
      nombre: 'Cliente Prueba',
      telefono: telefonoValido(1000 + ++secuencia),
      correo,
      clave,
      aceptaPoliticaDatos: true,
      aceptaTerminos: true,
      ...cambios,
    },
  });

export const iniciarSesionCuenta = (ctx: Contexto, correo: unknown, clave: unknown) =>
  pedir(ctx, '/api/v1/cuentas/login', { method: 'POST', body: { correo, clave } });

// Reserva de invitado en el negocio A: acepta la política y los términos, como exige la API
export const reservaValida = (cambios: Record<string, unknown> = {}) => ({
  empresaId: 'emp_a',
  barberoId: 'barb_a',
  servicioId: 'serv_a',
  fecha: FECHA_FUTURA,
  hora: '10:00 AM',
  nombre: 'Cliente Prueba',
  telefono: '3001234567',
  indicativo: '57',
  aceptaPoliticaDatos: true,
  aceptaTerminos: true,
  ...cambios,
});

// Superadmin de prueba con su segundo paso (TOTP) real: lo crea directo en la base, igual que el comando de
// desarrollador, y devuelve su token tras iniciar sesión por la API.
export const crearSuperadmin = async (ctx: Contexto): Promise<string> => {
  const correo = 'superadmin@plataforma.co';
  const clave = 'Super-admin-123!';
  const secreto = generarSecretoTotp();
  await ctx.pool.query('INSERT INTO superadmins (correo, password_hash, totp_secreto) VALUES ($1, $2, $3)', [
    correo,
    await cifrarContrasena(clave),
    cifrarSecreto(secreto, SECRETO_TOTP_PRUEBAS),
  ]);
  const r = await pedir(ctx, '/api/v1/superadmin/login', {
    method: 'POST',
    body: { correo, clave, codigo: codigoTotp(secreto) },
  });
  if (r.estado !== 200) throw new Error(`Login del superadmin falló con ${r.estado}: ${r.texto}`);
  return r.json.token;
};

// Espera a que se cumpla algo que ocurre sin esperar la respuesta (ej. los avisos que se guardan después de reservar)
export const esperarHasta = async <T>(consulta: () => Promise<T | undefined | null | false>, intentos = 40): Promise<T> => {
  for (let i = 0; i < intentos; i++) {
    const valor = await consulta();
    if (valor) return valor;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('No ocurrió a tiempo lo que se esperaba');
};
