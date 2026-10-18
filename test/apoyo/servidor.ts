import { type ChildProcess, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import type pg from 'pg';
import { crearApp } from '../../src/app.js';
import { cargarEntorno, type Entorno } from '../../src/config/entorno.js';
import type { ConfigLimites } from '../../src/shared/http/limitadores.js';
import { type BaseDePrueba, crearBaseDePrueba, FECHA_FUTURA } from './baseDePrueba.js';

export const SECRETO_PRUEBAS = 'secreto-de-pruebas-con-mas-de-32-caracteres';

// Límites altos para que las pruebas no choquen con ellos (salvo la que los prueba)
const LIMITES_PRUEBA: ConfigLimites = {
  ventanaMs: 60_000,
  general: 10_000,
  login: 1_000,
  codigoNegocio: 1_000,
  reservas: 1_000,
};

export type Contexto = { url: string; pool: pg.Pool; cerrar: () => Promise<void> };

type Opciones = { limites?: Partial<ConfigLimites>; entorno?: Partial<Entorno> };

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

  if (baselineDir) {
    const puerto = await puertoLibre();
    const proceso: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: baselineDir,
      env: { ...process.env, DB_NAME: base.nombre, PORT: String(puerto), JWT_SECRET: SECRETO_PRUEBAS },
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

  const entorno: Entorno = {
    ...cargarEntorno({ ...process.env, NODE_ENV: 'test', JWT_SECRET: SECRETO_PRUEBAS }),
    DB_NAME: base.nombre,
    ...opciones.entorno,
  };
  const app = crearApp({ pool: base.pool, entorno, limites: { ...LIMITES_PRUEBA, ...opciones.limites } });
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

export const reservaValida = (cambios: Record<string, unknown> = {}) => ({
  empresaId: 'emp_a',
  barberoId: 'barb_a',
  servicioId: 'serv_a',
  fecha: FECHA_FUTURA,
  hora: '10:00 AM',
  nombre: 'Cliente Prueba',
  telefono: '3001234567',
  indicativo: '57',
  ...cambios,
});
