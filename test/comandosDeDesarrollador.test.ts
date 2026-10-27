import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { confirmar, motivoDeNegacion, registrarComandoSinFallar } from '../src/db/comandos.js';
import type { Consultable } from '../src/db/pool.js';
import { cifrarContrasena } from '../src/modules/auth/contrasenas.js';
import { leerConfigPruebas } from './apoyo/configuracionPruebas.js';
import {
  type Contexto,
  iniciar,
  SECRETO_PRUEBAS,
  SECRETO_RECUPERACION_PRUEBAS,
  SECRETO_TOTP_PRUEBAS,
} from './apoyo/servidor.js';

// B-6 — comandos de consola: registro en la actividad del superadmin, negación en producción y confirmación
describe('comandos de desarrollador', () => {
  let ctx: Contexto;
  const prueba = leerConfigPruebas();

  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  // Ejecuta el script real contra la base temporal de la prueba. entrada = lo que se teclea (confirmaciones).
  const ejecutar = (script: string, args: string[], opciones: { produccion?: boolean; entrada?: string } = {}) =>
    new Promise<{ codigo: number | null; salida: string }>((resolver) => {
      const proceso = spawn(process.execPath, ['--import', 'tsx', `src/db/${script}.ts`, ...args], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DB_HOST: prueba.host,
          DB_PORT: String(prueba.port),
          DB_USER: prueba.user,
          DB_PASSWORD: prueba.password,
          DB_NAME: ctx.pool.options.database,
          JWT_SECRET: SECRETO_PRUEBAS,
          RECUPERACION_SECRET: SECRETO_RECUPERACION_PRUEBAS,
          TOTP_SECRET: SECRETO_TOTP_PRUEBAS,
          NODE_ENV: opciones.produccion ? 'production' : 'development',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let salida = '';
      // Si un comando se queda esperando algo, la prueba falla con lo que alcanzó a decir
      const limite = setTimeout(() => {
        salida += ' [la prueba detuvo el comando por tardar demasiado]';
        proceso.kill();
      }, 60_000);
      proceso.on('close', () => clearTimeout(limite));
      proceso.stdout.on('data', (d) => (salida += d));
      proceso.stderr.on('data', (d) => (salida += d));
      proceso.on('close', (codigo) => resolver({ codigo, salida }));
      proceso.stdin.end(opciones.entrada ?? '');
    });

  const actividad = async () =>
    (await ctx.pool.query('SELECT superadmin_id, superadmin_correo, accion, empresa_codigo, referencia, detalle FROM actividad_superadmin ORDER BY id')).rows;
  const estadoDe = async () => (await ctx.pool.query("SELECT estado_suscripcion, plan_suscripcion FROM empresas WHERE codigo_acceso = 'NEGA'")).rows[0];

  test('con NODE_ENV=production se niegan los comandos que cambian dinero, accesos o datos, y no dejan nada', async () => {
    await ctx.pool.query("INSERT INTO superadmins (correo, password_hash, totp_secreto) VALUES ('a@x.co', 'h', 'x.y.z'), ('b@x.co', 'h', 'x.y.z')");
    const intentos: [string, string[]][] = [
      ['cargos', ['pagar', 'NEGA']],
      ['pqrs', ['responder', 'PQRS-2026-000001', 'resuelta', 'ok']],
      ['simularVencimiento', ['NEGA', '5']],
      ['crearSuperadmin', ['nuevo@x.co']],
      ['restablecerSuperadmin', ['a@x.co']],
      ['eliminarSuperadmin', ['b@x.co']],
    ];
    for (const [script, args] of intentos) {
      const r = await ejecutar(script, args, { produccion: true, entrada: 's\n' });
      assert.equal(r.codigo, 1, `${script}: ${r.salida}`);
      assert.match(r.salida, /no se ejecuta con NODE_ENV=production/, script);
    }
    assert.deepEqual(await actividad(), [], 'una negación no cambia ni registra nada');
    assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM superadmins')).rows[0].n, 2);
    // Los de solo lectura sí funcionan
    assert.equal((await ejecutar('cargos', ['listar', 'NEGA'], { produccion: true })).codigo, 0);
    assert.equal((await ejecutar('pqrs', ['listar'], { produccion: true })).codigo, 0);
  });

  test('el mensaje de negación nombra el comando y no se puede evitar con confirmaciones', () => {
    assert.match(motivoDeNegacion('dev:cargos pagar', { NODE_ENV: 'production' })!, /dev:cargos pagar/);
    assert.equal(motivoDeNegacion('dev:cargos pagar', { NODE_ENV: 'development' }), null);
    assert.equal(motivoDeNegacion('dev:cargos pagar', {}), null);
  });

  test('dev:activar-plan pide confirmación: sin un sí, no cambia nada y no se registra', async () => {
    const antes = await estadoDe();
    for (const entrada of ['', 'n\n', '\n', 'quizás\n']) {
      const r = await ejecutar('activarPlan', ['NEGA', 'mensual'], { entrada });
      assert.equal(r.codigo, 0, r.salida);
      assert.match(r.salida, /¿Activar el plan mensual de Negocio A \(NEGA\)/);
      assert.match(r.salida, /Cancelado: no se cambió nada/);
    }
    assert.deepEqual(await estadoDe(), antes);
    assert.deepEqual(await actividad(), []);
  });

  test('dev:activar-plan con un sí activa el plan y lo anota en la actividad del superadmin, también en producción', async () => {
    const r = await ejecutar('activarPlan', ['NEGA', 'anual'], { entrada: 's\n', produccion: true });
    assert.equal(r.codigo, 0, r.salida);
    assert.match(r.salida, /✔ Negocio A \(NEGA\)/);
    assert.deepEqual(await estadoDe(), { estado_suscripcion: 'activa', plan_suscripcion: 'anual' });
    const [fila, ...otras] = await actividad();
    assert.equal(otras.length, 0);
    assert.equal(fila.superadmin_id, 'sistema');
    assert.equal(fila.superadmin_correo, 'comando:dev:activar-plan');
    assert.equal(fila.accion, 'cmd_activar_plan');
    assert.equal(fila.empresa_codigo, 'NEGA');
    assert.equal(fila.detalle.periodo, 'anual');
    assert.equal(typeof fila.detalle.precio, 'number');
  });

  test('un negocio que no existe no pide confirmación ni deja registro', async () => {
    const antes = (await actividad()).length;
    const r = await ejecutar('activarPlan', ['NOEXISTE', 'mensual'], { entrada: 's\n' });
    assert.equal(r.codigo, 1);
    assert.match(r.salida, /No existe un negocio con el código NOEXISTE/);
    assert.equal((await actividad()).length, antes);
  });

  test('en desarrollo los demás comandos que cambian algo quedan registrados', async () => {
    const antes = (await actividad()).length;
    // cargos pagar
    await ctx.pool.query(
      "INSERT INTO cargos (empresa_id, empresa_codigo, empresa_nombre, monto, concepto, periodo, dias_restantes, dias_periodo, fecha) SELECT id, codigo_acceso, nombre, 12000, 'prueba', 'mensual', 10, 30, CURRENT_DATE FROM empresas WHERE codigo_acceso = 'NEGA'",
    );
    const pagar = await ejecutar('cargos', ['pagar', 'NEGA']);
    assert.equal(pagar.codigo, 0, pagar.salida);
    // simular vencimiento
    const vencer = await ejecutar('simularVencimiento', ['NEGA', '5']);
    assert.equal(vencer.codigo, 0, vencer.salida);
    // restablecer la contraseña de un superadmin
    await ctx.pool.query('UPDATE superadmins SET password_hash = $1', [await cifrarContrasena('Super-admin-123!')]);
    const restablecer = await ejecutar('restablecerSuperadmin', ['a@x.co']);
    assert.equal(restablecer.codigo, 0, restablecer.salida);
    // eliminar un superadmin (pide confirmación)
    const eliminar = await ejecutar('eliminarSuperadmin', ['b@x.co'], { entrada: 's\n' });
    assert.equal(eliminar.codigo, 0, eliminar.salida);

    const nuevas = (await actividad()).slice(antes);
    assert.deepEqual(
      nuevas.map((f) => [f.superadmin_correo, f.accion]),
      [
        ['comando:dev:cargos', 'cmd_pagar_cargos'],
        ['comando:dev:simular-vencimiento', 'cmd_simular_vencimiento'],
        ['comando:dev:restablecer-superadmin', 'cmd_restablecer_superadmin'],
        ['comando:dev:eliminar-superadmin', 'cmd_eliminar_superadmin'],
      ],
    );
    assert.equal(nuevas[0].detalle.total, 12000);
    assert.equal(nuevas[1].detalle.dias, 5);
    assert.equal(nuevas[3].detalle.correo, 'b@x.co');
    // Ningún registro guarda contraseñas ni claves
    assert.ok(!JSON.stringify(nuevas).includes('Super-admin'), 'sin contraseñas');
    // Y el registro sigue siendo de solo inserción
    await assert.rejects(ctx.pool.query("UPDATE actividad_superadmin SET accion = 'x'"), /no se puede modificar/);
  });

  test('dev:crear-superadmin en desarrollo crea la cuenta y lo anota', async () => {
    const carpeta = 'secretos-superadmin';
    try {
      const r = await ejecutar('crearSuperadmin', ['creado.por.comando@x.co']);
      assert.equal(r.codigo, 0, r.salida);
      assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM superadmins WHERE correo = 'creado.por.comando@x.co'")).rows[0].n, 1);
      const ultima = (await actividad()).at(-1)!;
      assert.deepEqual([ultima.superadmin_correo, ultima.accion, ultima.detalle.correo], ['comando:dev:crear-superadmin', 'cmd_crear_superadmin', 'creado.por.comando@x.co']);
    } finally {
      // El comando guarda el QR en secretos-superadmin/: solo se borra el de esta prueba
      rmSync(`${carpeta}/totp-creado.por.comando_x.co.png`, { force: true });
      rmSync(`${carpeta}/totp-creado.por.comando@x.co.png`, { force: true });
    }
  });

  test('si anotar el comando falla, el cambio no se pierde: se avisa y no se lanza el error', async () => {
    const caida = { query: async () => Promise.reject(new Error('base caída')) } as unknown as Consultable;
    const original = console.error;
    const lineas: string[] = [];
    const codigoAntes = process.exitCode;
    console.error = (...partes: unknown[]) => void lineas.push(partes.join(' '));
    try {
      await registrarComandoSinFallar(caida, { comando: 'dev:x', accion: 'x' });
    } finally {
      console.error = original;
      process.exitCode = codigoAntes;
    }
    assert.match(lineas.join(' '), /El cambio se hizo, pero no se pudo anotar en la actividad del superadmin: base caída/);
  });

  test('confirmar() solo acepta s, si o sí, y cancela si no hay quien responda', async () => {
    // Como en la terminal: la persona responde después de ver la pregunta
    const responder = async (texto: string) => {
      const flujo = new PassThrough();
      const respuesta = confirmar('¿Seguro?', flujo);
      setImmediate(() => flujo.end(texto));
      return respuesta;
    };
    for (const [texto, esperado] of [['s\n', true], ['SI\n', true], ['sí\n', true], ['n\n', false], ['\n', false], ['claro\n', false], ['', false]] as const) {
      assert.equal(await responder(texto), esperado, JSON.stringify(texto));
    }
  });
});
