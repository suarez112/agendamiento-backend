import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { cargarEntorno } from '../src/config/entorno.js';
import { crearEnviadorCorreo, crearEnviadorResend, ErrorEnvioCorreo } from '../src/shared/correo.js';
import { CLAVE_CLIENTE, type Contexto, esperarHasta, iniciar, pedir, registrarCliente } from './apoyo/servidor.js';

// Sending system emails through the Resend API (password recovery first).

const CLAVE_RESEND = 're_prueba_123456789';
const REMITENTE = 'Agendality <no-reply@agendality.com>';
const RESPONDER_A = 'soporte@agendality.com';
const MENSAJE_GENERICO =
  'Si el correo pertenece a una cuenta, te enviamos un código de 6 dígitos para restablecer tu contraseña. Vence en 15 minutos.';

type Llamada = { url: string; init: RequestInit };

// Fake fetch: records every call and answers with the given response (or throws the given error)
const fetchFalso = (responder: () => Response | Promise<Response>) => {
  const llamadas: Llamada[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init: init ?? {} });
    return responder();
  }) as typeof fetch;
  return { fn, llamadas };
};

const json = (estado: number, cuerpo: unknown) =>
  new Response(JSON.stringify(cuerpo), { status: estado, headers: { 'Content-Type': 'application/json' } });

// Captures everything written to console.log / console.error while `trabajo` runs
const capturarConsola = async (trabajo: () => Promise<void>) => {
  const lineas: string[] = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => void lineas.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => void lineas.push(a.map(String).join(' '));
  try {
    await trabajo();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lineas.join('\n');
};

// Environment without the developer's own mail settings
const entornoBase = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    JWT_SECRET: 'a'.repeat(40),
    RECUPERACION_SECRET: 'b'.repeat(40),
    TOTP_SECRET: 'c'.repeat(40),
  };
  for (const v of ['PROVEEDOR_PAGO', 'RESEND_API_KEY', 'CORREO_REMITENTE', 'CORREO_RESPONDER_A']) delete env[v];
  return { ...env, ...extra };
};

const errorDeEntorno = (extra: NodeJS.ProcessEnv) => {
  try {
    cargarEntorno(entornoBase(extra));
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

describe('Resend sender', () => {
  test('sends one POST to the Resend API with the key, sender, reply-to, recipient, subject and text', async () => {
    const f = fetchFalso(() => json(200, { id: 'abc' }));
    const enviador = crearEnviadorResend({ apiKey: CLAVE_RESEND, remitente: REMITENTE, responderA: RESPONDER_A, fetch: f.fn });
    await enviador.enviar({ para: 'ana@central.co', asunto: 'Asunto', texto: 'Hola' });

    assert.equal(f.llamadas.length, 1);
    const { url, init } = f.llamadas[0];
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.method, 'POST');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${CLAVE_RESEND}`);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.ok(init.signal, 'the request has a timeout');
    assert.deepEqual(JSON.parse(String(init.body)), {
      from: REMITENTE,
      to: ['ana@central.co'],
      subject: 'Asunto',
      text: 'Hola',
      reply_to: RESPONDER_A,
    });
  });

  test('without a reply-to address the field is not sent', async () => {
    const f = fetchFalso(() => json(200, { id: 'abc' }));
    await crearEnviadorResend({ apiKey: CLAVE_RESEND, remitente: REMITENTE, fetch: f.fn }).enviar({
      para: 'ana@central.co',
      asunto: 'A',
      texto: 'B',
    });
    assert.equal('reply_to' in JSON.parse(String(f.llamadas[0].init.body)), false);
  });

  test('a rejected request fails with only the HTTP status and error type, never the address, text or key', async () => {
    const f = fetchFalso(() =>
      json(422, { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field: ana@central.co 123456' }),
    );
    const enviador = crearEnviadorResend({ apiKey: CLAVE_RESEND, remitente: REMITENTE, fetch: f.fn });
    const error = await enviador.enviar({ para: 'ana@central.co', asunto: 'A', texto: 'código 123456' }).then(
      () => assert.fail('it should fail'),
      (e: unknown) => e as Error,
    );
    assert.ok(error instanceof ErrorEnvioCorreo);
    assert.match(error.message, /422/);
    assert.match(error.message, /validation_error/);
    for (const privado of ['ana@central.co', '123456', CLAVE_RESEND]) assert.equal(error.message.includes(privado), false, privado);
  });

  test('an unexpected error type from Resend is not copied into the message', async () => {
    const f = fetchFalso(() => json(500, { name: 'ana@central.co', message: 'x' }));
    const error = await crearEnviadorResend({ apiKey: CLAVE_RESEND, remitente: REMITENTE, fetch: f.fn })
      .enviar({ para: 'ana@central.co', asunto: 'A', texto: 'B' })
      .then(() => assert.fail('it should fail'), (e: unknown) => e as Error);
    assert.ok(error instanceof ErrorEnvioCorreo);
    assert.match(error.message, /500/);
    assert.equal(error.message.includes('ana@central.co'), false);
  });

  test('a network error or timeout fails without personal data', async () => {
    const f = fetchFalso(() => {
      throw new TypeError('fetch failed for ana@central.co');
    });
    const error = await crearEnviadorResend({ apiKey: CLAVE_RESEND, remitente: REMITENTE, fetch: f.fn })
      .enviar({ para: 'ana@central.co', asunto: 'A', texto: 'B' })
      .then(() => assert.fail('it should fail'), (e: unknown) => e as Error);
    assert.ok(error instanceof ErrorEnvioCorreo);
    assert.equal(error.message.includes('ana@central.co'), false);

    // A real timeout: the server never answers and the request is aborted
    const lento = (async (_u: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_r, rechazar) => init?.signal?.addEventListener('abort', () => rechazar(init.signal!.reason)))) as typeof fetch;
    const porTiempo = await crearEnviadorResend({ apiKey: CLAVE_RESEND, remitente: REMITENTE, fetch: lento, tiempoMs: 20 })
      .enviar({ para: 'ana@central.co', asunto: 'A', texto: 'B' })
      .then(() => assert.fail('it should fail'), (e: unknown) => e as Error);
    assert.ok(porTiempo instanceof ErrorEnvioCorreo);
  });
});

describe('choosing the email sender', () => {
  const correo = { para: 'ana@central.co', asunto: 'Asunto', texto: 'código 654321' };

  test('with a Resend key outside the tests, emails go through Resend', async () => {
    const f = fetchFalso(() => json(200, { id: 'abc' }));
    const enviador = crearEnviadorCorreo(
      { NODE_ENV: 'production', RESEND_API_KEY: CLAVE_RESEND, CORREO_REMITENTE: REMITENTE, CORREO_RESPONDER_A: RESPONDER_A },
      { fetch: f.fn },
    );
    const salida = await capturarConsola(() => enviador.enviar(correo));
    assert.equal(f.llamadas.length, 1);
    assert.equal(salida.includes('654321'), false, 'the code is never written to the logs');
  });

  test('without a key in production nothing is sent and only correo_sin_proveedor is logged (unchanged)', async () => {
    const f = fetchFalso(() => json(200, {}));
    const salida = await capturarConsola(() => crearEnviadorCorreo({ NODE_ENV: 'production' }, { fetch: f.fn }).enviar(correo));
    assert.equal(f.llamadas.length, 0);
    assert.match(salida, /correo_sin_proveedor/);
    assert.equal(salida.includes('654321'), false);
  });

  test('without a key in development the email is printed to the console (unchanged)', async () => {
    const f = fetchFalso(() => json(200, {}));
    const salida = await capturarConsola(() => crearEnviadorCorreo({ NODE_ENV: 'development' }, { fetch: f.fn }).enviar(correo));
    assert.equal(f.llamadas.length, 0);
    assert.match(salida, /654321/);
  });

  test('in the tests nothing is ever sent, even with a key', async () => {
    const f = fetchFalso(() => json(200, {}));
    await capturarConsola(() =>
      crearEnviadorCorreo({ NODE_ENV: 'test', RESEND_API_KEY: CLAVE_RESEND, CORREO_REMITENTE: REMITENTE }, { fetch: f.fn }).enviar(correo),
    );
    assert.equal(f.llamadas.length, 0);
  });
});

describe('email configuration', () => {
  test('a complete configuration is read', () => {
    const e = cargarEntorno(entornoBase({ RESEND_API_KEY: CLAVE_RESEND, CORREO_REMITENTE: REMITENTE, CORREO_RESPONDER_A: RESPONDER_A }));
    assert.deepEqual([e.RESEND_API_KEY, e.CORREO_REMITENTE, e.CORREO_RESPONDER_A], [CLAVE_RESEND, REMITENTE, RESPONDER_A]);
  });

  test('everything is optional, and blank values count as not set', () => {
    const e = cargarEntorno(entornoBase({ RESEND_API_KEY: '  ', CORREO_REMITENTE: '', CORREO_RESPONDER_A: '' }));
    assert.deepEqual([e.RESEND_API_KEY, e.CORREO_REMITENTE, e.CORREO_RESPONDER_A], [undefined, undefined, undefined]);
  });

  test('a plain address is accepted as the sender', () => {
    assert.equal(cargarEntorno(entornoBase({ RESEND_API_KEY: CLAVE_RESEND, CORREO_REMITENTE: 'no-reply@agendality.com' })).CORREO_REMITENTE, 'no-reply@agendality.com');
  });

  test('with a key, the sender is required', () => {
    assert.match(errorDeEntorno({ RESEND_API_KEY: CLAVE_RESEND }) ?? '', /CORREO_REMITENTE/);
  });

  test('a key that is not a Resend key is rejected without showing it', () => {
    const mensaje = errorDeEntorno({ RESEND_API_KEY: 'sk_live_secreto', CORREO_REMITENTE: REMITENTE }) ?? '';
    assert.match(mensaje, /RESEND_API_KEY/);
    assert.equal(mensaje.includes('sk_live_secreto'), false);
  });

  test('an invalid sender or reply-to address is rejected', () => {
    assert.match(errorDeEntorno({ RESEND_API_KEY: CLAVE_RESEND, CORREO_REMITENTE: 'Agendality' }) ?? '', /CORREO_REMITENTE/);
    assert.match(errorDeEntorno({ RESEND_API_KEY: CLAVE_RESEND, CORREO_REMITENTE: 'Agendality <no-reply>' }) ?? '', /CORREO_REMITENTE/);
    assert.match(
      errorDeEntorno({ RESEND_API_KEY: CLAVE_RESEND, CORREO_REMITENTE: REMITENTE, CORREO_RESPONDER_A: 'soporte' }) ?? '',
      /CORREO_RESPONDER_A/,
    );
  });
});

describe('password recovery through Resend', () => {
  let ctx: Contexto;
  let respuestaResend: () => Response | Promise<Response>;
  const resend = fetchFalso(() => respuestaResend());

  before(async () => {
    ctx = await iniciar({
      correo: crearEnviadorResend({ apiKey: CLAVE_RESEND, remitente: REMITENTE, responderA: RESPONDER_A, fetch: resend.fn }),
    });
  });
  after(() => ctx.cerrar());

  const solicitar = (correo: string) =>
    pedir(ctx, '/api/v1/cuentas/solicitar-recuperacion', { method: 'POST', body: { correo } });
  const codigoEnviado = (i: number) => (JSON.parse(String(resend.llamadas[i].init.body)).text as string).match(/\b(\d{6})\b/)![1];

  test('the code is sent through Resend, can be used, and is never written to the logs', async () => {
    respuestaResend = () => json(200, { id: 'abc' });
    const correo = 'recupera.resend@correo.com';
    assert.equal((await registrarCliente(ctx, correo, CLAVE_CLIENTE)).estado, 201);
    const antes = resend.llamadas.length;

    let respuesta!: Awaited<ReturnType<typeof solicitar>>;
    const salida = await capturarConsola(async () => {
      respuesta = await solicitar(correo);
      await esperarHasta(async () => resend.llamadas.length > antes);
    });
    assert.equal(respuesta.estado, 200);
    assert.deepEqual(respuesta.json, { mensaje: MENSAJE_GENERICO });

    const enviado = JSON.parse(String(resend.llamadas[antes].init.body));
    assert.deepEqual(enviado.to, [correo]);
    assert.equal(enviado.from, REMITENTE);
    assert.equal(enviado.reply_to, RESPONDER_A);
    const codigo = codigoEnviado(antes);
    assert.equal(salida.includes(codigo), false, 'the code is not in the logs');

    const cambio = await pedir(ctx, '/api/v1/cuentas/restablecer-contrasena', {
      method: 'POST',
      body: { correo, codigo, clave: 'Nueva-clave-9!' },
    });
    assert.equal(cambio.estado, 200, cambio.texto);
  });

  test('if Resend fails, the answer is the same generic one and the failure is logged without personal data', async () => {
    respuestaResend = () => json(500, { statusCode: 500, name: 'application_error', message: 'boom ana' });
    const correo = 'recupera.falla@correo.com';
    assert.equal((await registrarCliente(ctx, correo, CLAVE_CLIENTE)).estado, 201);
    const antes = resend.llamadas.length;

    let existe!: Awaited<ReturnType<typeof solicitar>>;
    let noExiste!: Awaited<ReturnType<typeof solicitar>>;
    const salida = await capturarConsola(async () => {
      existe = await solicitar(correo);
      await esperarHasta(async () => resend.llamadas.length > antes);
      // Give the rejected send time to be logged
      await new Promise((r) => setTimeout(r, 50));
      noExiste = await solicitar('nadie.existe@correo.com');
    });

    assert.equal(existe.estado, 200);
    assert.equal(noExiste.estado, 200);
    assert.deepEqual(existe.json, { mensaje: MENSAJE_GENERICO });
    assert.deepEqual(existe.json, noExiste.json, 'the same answer whether the account exists or not');

    assert.match(salida, /correo_no_enviado/);
    assert.match(salida, /500/);
    const codigo = codigoEnviado(antes);
    for (const privado of [correo, codigo, CLAVE_RESEND]) assert.equal(salida.includes(privado), false, privado);
  });
});
