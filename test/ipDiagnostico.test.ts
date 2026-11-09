import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import express from 'express';
import { cargarEntorno } from '../src/config/entorno.js';
import { AJUSTE_CLOUDFLARE, ipDe } from '../src/shared/http/ip.js';
import type { DatosDiagnosticoIp } from '../src/shared/http/diagnosticoIp.js';
import { iniciar, pedir, SECRETO_PRUEBAS, SECRETO_RECUPERACION_PRUEBAS, SECRETO_TOTP_PRUEBAS } from './apoyo/servidor.js';

// App mínima (sin base de datos) que devuelve lo que resuelve ipDe, para probar la lectura de la IP con cabeceras falsas
const consultarIp = async (confianza: number, headers: Record<string, string>, cloudflare = false) => {
  const app = express();
  app.set('trust proxy', confianza);
  app.set(AJUSTE_CLOUDFLARE, cloudflare);
  app.get('/ip', (req, res) => res.json({ ip: ipDe(req) }));
  const servidor: Server = await new Promise((resolver) => {
    const s = app.listen(0, '127.0.0.1', () => resolver(s as unknown as Server));
  });
  try {
    const { port } = servidor.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}/ip`, { headers });
    return ((await r.json()) as { ip: string | null }).ip;
  } finally {
    await new Promise((r) => servidor.close(r));
  }
};

describe('ipDe con X-Forwarded-For falsificado', () => {
  test('un solo proxy de confianza: lo que el cliente escribe a la izquierda se ignora; vale la IP que añadió el proxy', async () => {
    assert.equal(await consultarIp(1, { 'X-Forwarded-For': '1.2.3.4, 203.0.113.9' }), '203.0.113.9');
    assert.equal(await consultarIp(1, { 'X-Forwarded-For': '1.2.3.4, 5.6.7.8, 203.0.113.9' }), '203.0.113.9');
  });

  test('dos proxies de confianza: se saltan los dos últimos saltos y se descarta lo escrito por el cliente', async () => {
    assert.equal(await consultarIp(2, { 'X-Forwarded-For': '1.2.3.4, 203.0.113.9, 104.23.0.1' }), '203.0.113.9');
  });

  test('sin proxy de confianza se ignora X-Forwarded-For: es la IP de la conexión', async () => {
    const ip = await consultarIp(0, { 'X-Forwarded-For': '1.2.3.4' });
    assert.ok(ip === '127.0.0.1' || ip === '::1', `ip=${ip}`);
  });

  test('si se cuentan más proxies de los reales, la IP inventada se cuela (por eso no se debe subir TRUST_PROXY sin medir)', async () => {
    assert.equal(await consultarIp(2, { 'X-Forwarded-For': '1.2.3.4, 203.0.113.9' }), '1.2.3.4');
  });

  test('True-Client-IP y CF-Connecting-IP no cambian la IP si no se declaró Cloudflare', async () => {
    assert.equal(
      await consultarIp(1, { 'X-Forwarded-For': '203.0.113.9', 'True-Client-IP': '1.2.3.4', 'CF-Connecting-IP': '5.6.7.8' }),
      '203.0.113.9',
    );
  });
});

describe('diagnóstico de IP (DIAGNOSTICO_IP)', () => {
  const CABECERAS = {
    'X-Forwarded-For': '1.2.3.4, 203.0.113.9',
    'CF-Connecting-IP': '198.51.100.7',
    'True-Client-IP': '198.51.100.8',
    // Nada de esto debe aparecer en el registro
    Authorization: 'Bearer token-secreto-de-prueba',
    Cookie: 'sesion=cookie-secreta-de-prueba',
    'User-Agent': 'agente-de-prueba',
    'X-Otra-Cabecera': 'valor-que-no-debe-salir',
  };

  test('apagado (por defecto) no registra nada', async () => {
    const escritos: DatosDiagnosticoIp[] = [];
    const ctx = await iniciar({ diagnosticoIp: (d) => escritos.push(d) });
    try {
      const r = await pedir(ctx, '/api/v1/planes', { headers: CABECERAS });
      assert.equal(r.estado, 200, r.texto);
      assert.deepEqual(escritos, []);
    } finally {
      await ctx.cerrar();
    }
  });

  test('apagado explícito (DIAGNOSTICO_IP=false) tampoco registra nada', async () => {
    const escritos: DatosDiagnosticoIp[] = [];
    const ctx = await iniciar({ entorno: { DIAGNOSTICO_IP: false, TRUST_PROXY: 1 }, diagnosticoIp: (d) => escritos.push(d) });
    try {
      await pedir(ctx, '/api/v1/planes', { headers: CABECERAS });
      assert.deepEqual(escritos, []);
    } finally {
      await ctx.cerrar();
    }
  });

  test('encendido registra solo las cinco IP y nunca otras cabeceras, Authorization ni cookies', async () => {
    const escritos: DatosDiagnosticoIp[] = [];
    const ctx = await iniciar({ entorno: { DIAGNOSTICO_IP: true, TRUST_PROXY: 1 }, diagnosticoIp: (d) => escritos.push(d) });
    try {
      const r = await pedir(ctx, '/api/v1/planes', { headers: CABECERAS });
      assert.equal(r.estado, 200, r.texto);
      assert.equal(escritos.length, 1);
      const [datos] = escritos;
      assert.deepEqual(Object.keys(datos).sort(), ['cfConnectingIp', 'conexion', 'reqIp', 'trueClientIp', 'xForwardedFor']);
      assert.ok(datos.conexion === '127.0.0.1' || datos.conexion === '::ffff:127.0.0.1' || datos.conexion === '::1', `conexion=${datos.conexion}`);
      assert.equal(datos.xForwardedFor, '1.2.3.4, 203.0.113.9');
      assert.equal(datos.cfConnectingIp, '198.51.100.7');
      assert.equal(datos.trueClientIp, '198.51.100.8');
      assert.equal(datos.reqIp, '203.0.113.9');
      const texto = JSON.stringify(datos);
      for (const secreto of ['token-secreto-de-prueba', 'cookie-secreta-de-prueba', 'agente-de-prueba', 'valor-que-no-debe-salir', 'Bearer']) {
        assert.ok(!texto.includes(secreto), `el registro contiene "${secreto}"`);
      }
    } finally {
      await ctx.cerrar();
    }
  });

  test('las cabeceras ausentes quedan en null y las muy largas se recortan', async () => {
    const escritos: DatosDiagnosticoIp[] = [];
    const ctx = await iniciar({ entorno: { DIAGNOSTICO_IP: true }, diagnosticoIp: (d) => escritos.push(d) });
    try {
      await pedir(ctx, '/api/v1/planes');
      await pedir(ctx, '/api/v1/planes', { headers: { 'X-Forwarded-For': '9'.repeat(5000) } });
      assert.equal(escritos[0].xForwardedFor, null);
      assert.equal(escritos[0].cfConnectingIp, null);
      assert.equal(escritos[0].trueClientIp, null);
      assert.equal(escritos[1].xForwardedFor?.length, 300);
    } finally {
      await ctx.cerrar();
    }
  });

  test('un fallo al escribir el diagnóstico no rompe la solicitud y se avisa una sola vez', async () => {
    const errores: string[] = [];
    const original = console.error;
    console.error = (linea: string) => errores.push(String(linea));
    const ctx = await iniciar({
      entorno: { DIAGNOSTICO_IP: true },
      diagnosticoIp: () => {
        throw new Error('fallo de prueba');
      },
    });
    try {
      assert.equal((await pedir(ctx, '/api/v1/planes')).estado, 200);
      assert.equal((await pedir(ctx, '/api/v1/planes')).estado, 200);
    } finally {
      console.error = original;
      await ctx.cerrar();
    }
    assert.equal(errores.filter((e) => e.includes('diagnostico_ip_fallo')).length, 1);
  });

  test('la salida real (registro del servidor) es una línea JSON diagnostico_ip con solo las cinco claves', async () => {
    const lineas: string[] = [];
    const originalLog = console.log;
    const originalEnv = process.env.NODE_ENV;
    const ctx = await iniciar({ entorno: { DIAGNOSTICO_IP: true, TRUST_PROXY: 1 } });
    // El registro calla fuera de las pruebas de error cuando NODE_ENV=test: se simula el entorno real solo durante la solicitud
    process.env.NODE_ENV = 'development';
    console.log = (linea: string) => lineas.push(String(linea));
    try {
      await pedir(ctx, '/api/v1/planes', { headers: { 'X-Forwarded-For': '203.0.113.9', Authorization: 'Bearer secreto-de-prueba' } });
    } finally {
      console.log = originalLog;
      process.env.NODE_ENV = originalEnv;
      await ctx.cerrar();
    }
    const linea = lineas.find((l) => l.includes('diagnostico_ip'));
    assert.ok(linea, `líneas: ${lineas.join(' | ')}`);
    const datos = JSON.parse(linea) as Record<string, unknown>;
    assert.deepEqual(Object.keys(datos).sort(), ['cfConnectingIp', 'conexion', 'evento', 'fecha', 'nivel', 'reqIp', 'trueClientIp', 'xForwardedFor']);
    assert.equal(datos.evento, 'diagnostico_ip');
    assert.equal(datos.reqIp, '203.0.113.9');
    assert.ok(!linea.includes('secreto-de-prueba'));
  });

  test('con el límite general agotado, las solicitudes rechazadas no dejan diagnóstico', async () => {
    const escritos: DatosDiagnosticoIp[] = [];
    const ctx = await iniciar({ entorno: { DIAGNOSTICO_IP: true }, limites: { general: 2 }, diagnosticoIp: (d) => escritos.push(d) });
    try {
      const estados = [];
      for (let i = 0; i < 5; i++) estados.push((await pedir(ctx, '/api/v1/planes')).estado);
      assert.equal(estados.filter((e) => e === 429).length, 3, estados.join(','));
      assert.equal(escritos.length, 2);
    } finally {
      await ctx.cerrar();
    }
  });

  test('la variable vale false por defecto, acepta true y rechaza otros valores', () => {
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      JWT_SECRET: SECRETO_PRUEBAS,
      RECUPERACION_SECRET: SECRETO_RECUPERACION_PRUEBAS,
      TOTP_SECRET: SECRETO_TOTP_PRUEBAS,
      DB_PASSWORD: 'x',
    };
    delete base.DIAGNOSTICO_IP;
    assert.equal(cargarEntorno(base).DIAGNOSTICO_IP, false);
    assert.equal(cargarEntorno({ ...base, DIAGNOSTICO_IP: 'true' }).DIAGNOSTICO_IP, true);
    assert.equal(cargarEntorno({ ...base, DIAGNOSTICO_IP: 'false' }).DIAGNOSTICO_IP, false);
    assert.throws(() => cargarEntorno({ ...base, DIAGNOSTICO_IP: 'si' }), /DIAGNOSTICO_IP/);
  });
});
