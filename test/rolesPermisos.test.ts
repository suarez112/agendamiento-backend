import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  CLAVE_CLIENTE,
  type Contexto,
  crearSuperadmin,
  iniciar,
  iniciarSesion,
  pedir,
  registrarCliente,
  registrarEmpresa,
} from './apoyo/servidor.js';
import { fechaEnDias } from './apoyo/baseDePrueba.js';

// Permisos por rol: anónimo, cliente con cuenta, empleado, administrador del personal, cuenta de la
// administradora y superadmin. Cada fila dice qué debe responder cada rol; así un cambio de permisos
// en cualquier endpoint hace fallar una prueba.
type Rol = 'anonimo' | 'cliente' | 'empleado' | 'adminPersonal' | 'adminCuenta' | 'superadmin';
const ROLES: Rol[] = ['anonimo', 'cliente', 'empleado', 'adminPersonal', 'adminCuenta', 'superadmin'];

// Orden de los estados esperados: anónimo, cliente, empleado, admin del personal, cuenta admin, superadmin
const MATRIZ: [ruta: string, esperados: [number, number, number, number, number, number]][] = [
  // Solo personal del negocio (el empleado ve solo lo suyo)
  ['/api/v1/citas/agenda', [401, 403, 200, 200, 200, 401]],
  ['/api/v1/cartera?desde=2026-01-01&hasta=2026-01-31', [401, 403, 200, 200, 200, 401]],
  ['/api/v1/cartera/resumen?periodo=mes', [401, 403, 200, 200, 200, 401]],
  ['/api/v1/empresas/actual', [401, 403, 200, 200, 200, 401]],
  ['/api/v1/funciones', [401, 403, 200, 200, 200, 401]],
  // Solo administradores
  ['/api/v1/equipo', [401, 403, 403, 200, 200, 401]],
  ['/api/v1/servicios', [401, 403, 403, 200, 200, 401]],
  ['/api/v1/productos', [401, 403, 403, 200, 200, 401]],
  ['/api/v1/bloqueos', [401, 403, 403, 200, 200, 401]],
  ['/api/v1/clientes', [401, 403, 403, 200, 200, 401]],
  ['/api/v1/clientes/lista-negra', [401, 403, 403, 200, 200, 401]],
  ['/api/v1/admin/empresa', [401, 403, 403, 200, 200, 401]],
  ['/api/v1/admin/empresa/suscripcion', [401, 403, 403, 200, 200, 401]],
  ['/api/v1/admin/empresa/guia', [401, 403, 403, 200, 200, 401]],
  ['/api/v1/admin/empresa/intervalo', [401, 403, 403, 200, 200, 401]],
  // Reportes: solo administradores (con el nivel Equipo o más; el control por nivel se prueba en cobro.test.ts)
  ['/api/v1/reportes/ocupacion?periodo=mes', [401, 403, 403, 200, 200, 401]],
  // Cliente con cuenta
  ['/api/v1/mi-cuenta/negocios', [401, 200, 401, 401, 403, 401]],
  ['/api/v1/mi-cuenta/citas', [401, 200, 401, 401, 403, 401]],
  // Cualquier sesión de la app (personal, administradora o cliente), nunca el superadmin
  ['/api/v1/notificaciones', [401, 200, 200, 200, 200, 401]],
  ['/api/v1/notificaciones/no-leidas', [401, 200, 200, 200, 200, 401]],
  ['/api/v1/legal/estado', [401, 200, 200, 200, 200, 401]],
  // Panel del dueño: solo el superadmin
  ['/api/v1/superadmin/resumen', [401, 401, 401, 401, 401, 200]],
  ['/api/v1/superadmin/negocios', [401, 401, 401, 401, 401, 200]],
  ['/api/v1/superadmin/pqrs', [401, 401, 401, 401, 401, 200]],
  ['/api/v1/superadmin/actividad', [401, 401, 401, 401, 401, 200]],
];

describe('permisos por rol', () => {
  let ctx: Contexto;
  const tokens: Record<Rol, string | undefined> = {
    anonimo: undefined,
    cliente: undefined,
    empleado: undefined,
    adminPersonal: undefined,
    adminCuenta: undefined,
    superadmin: undefined,
  };

  before(async () => {
    ctx = await iniciar();
    tokens.empleado = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    tokens.adminPersonal = await iniciarSesion(ctx, 'admin.a', '1234');
    const empresa = await registrarEmpresa(ctx, { correo: 'admin@c.co' });
    assert.equal(empresa.estado, 201);
    tokens.adminCuenta = empresa.json.token;
    const cliente = await registrarCliente(ctx, 'cliente@c.co', CLAVE_CLIENTE);
    assert.equal(cliente.estado, 201);
    tokens.cliente = cliente.json.token;
    tokens.superadmin = await crearSuperadmin(ctx);
  });
  after(() => ctx.cerrar());

  for (const [ruta, esperados] of MATRIZ) {
    test(`GET ${ruta.split('?')[0]}`, async () => {
      for (const [i, rol] of ROLES.entries()) {
        const r = await pedir(ctx, ruta, { token: tokens[rol] });
        assert.equal(r.estado, esperados[i], `${rol} en ${ruta}: ${r.texto}`);
      }
    });
  }

  test('un token falso o alterado no sirve en ninguna parte', async () => {
    const valido = tokens.adminPersonal!;
    const alterado = `${valido.slice(0, -4)}AAAA`;
    for (const token of ['token-falso', alterado, 'Bearer x']) {
      for (const ruta of ['/api/v1/equipo', '/api/v1/mi-cuenta/citas', '/api/v1/notificaciones', '/api/v1/superadmin/resumen']) {
        assert.equal((await pedir(ctx, ruta, { token })).estado, 401, `${ruta} con ${token.slice(0, 12)}`);
      }
    }
  });

  test('un empleado no puede crear, cambiar ni eliminar al equipo ni darse permisos de administrador', async () => {
    const token = tokens.empleado;
    const antes = (await ctx.pool.query('SELECT count(*)::int AS n FROM barberos')).rows[0].n;
    const crear = await pedir(ctx, '/api/v1/equipo', {
      method: 'POST',
      token,
      body: { nombre: 'Intruso', usuario: 'intruso', clave: 'Clave-segura-1', rol: 'admin' },
    });
    assert.equal(crear.estado, 403);
    const ascenderse = await pedir(ctx, '/api/v1/equipo/barb_a', { method: 'PATCH', token, body: { rol: 'admin' } });
    assert.equal(ascenderse.estado, 403);
    const eliminar = await pedir(ctx, '/api/v1/equipo/barb_a2', { method: 'DELETE', token });
    assert.equal(eliminar.estado, 403);
    assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM barberos')).rows[0].n, antes);
    const { rows } = await ctx.pool.query("SELECT es_admin, activo FROM barberos WHERE id IN ('barb_a', 'barb_a2') ORDER BY id");
    assert.deepEqual(rows, [
      { es_admin: false, activo: true },
      { es_admin: false, activo: true },
    ]);
  });

  test('un empleado no puede crear ni borrar bloqueos, servicios ni productos; el cliente tampoco', async () => {
    for (const token of [tokens.empleado, tokens.cliente]) {
      const intentos = await Promise.all([
        pedir(ctx, '/api/v1/servicios', { method: 'POST', token, body: { nombre: 'Gratis', duracionMin: 30, precio: 0 } }),
        pedir(ctx, '/api/v1/productos', { method: 'POST', token, body: { nombre: 'Gratis', precio: 0 } }),
        pedir(ctx, '/api/v1/bloqueos', {
          method: 'POST',
          token,
          body: { barberoId: 'barb_a', diaSemana: 1, horaInicio: '12:00', horaFin: '13:00' },
        }),
        pedir(ctx, '/api/v1/servicios/serv_a', { method: 'DELETE', token }),
        pedir(ctx, '/api/v1/clientes/lista-negra', { method: 'POST', token, body: { clienteId: 'cli_b' } }),
      ]);
      for (const r of intentos) assert.equal(r.estado, 403, r.texto);
    }
    const { rows } = await ctx.pool.query("SELECT (SELECT count(*)::int FROM servicios WHERE empresa_id = 'emp_a') AS servicios, (SELECT count(*)::int FROM bloqueos) AS bloqueos");
    assert.deepEqual(rows[0], { servicios: 2, bloqueos: 0 });
  });

  test('un administrador no puede quitarse a sí mismo el rol ni eliminar su propio usuario', async () => {
    const token = tokens.adminPersonal;
    const quitarRol = await pedir(ctx, '/api/v1/equipo/admin_a', { method: 'PATCH', token, body: { rol: 'empleado' } });
    assert.equal(quitarRol.estado, 400);
    assert.deepEqual(quitarRol.json, { error: 'No puedes quitarte a ti mismo el rol de administrador.' });
    const eliminarse = await pedir(ctx, '/api/v1/equipo/admin_a', { method: 'DELETE', token });
    assert.equal(eliminarse.estado, 400);
    assert.deepEqual(eliminarse.json, { error: 'No puedes eliminar tu propio usuario.' });
  });

  test('el cliente con cuenta no puede reservar a nombre de otra persona ni usar datos del cuerpo', async () => {
    // Con su sesión se usan el nombre y teléfono de la cuenta; lo que llegue en el cuerpo se ignora
    const cliente = await pedir(ctx, '/api/v1/mi-cuenta/citas', { token: tokens.cliente });
    assert.equal(cliente.estado, 200);
    const r = await pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      token: tokens.cliente,
      body: {
        empresaId: 'emp_a',
        barberoId: 'barb_a',
        servicioId: 'serv_a',
        fecha: fechaEnDias(3),
        hora: '10:00 AM',
        nombre: 'Otra Persona',
        telefono: '3001234567',
      },
    });
    assert.equal(r.estado, 201, r.texto);
    assert.equal(r.json.cita.cliente, 'Cliente Prueba', 'usa el nombre de la cuenta');
    assert.notEqual(r.json.cita.telefono, '+573001234567', 'usa el teléfono de la cuenta, no el del cuerpo');
  });
});
