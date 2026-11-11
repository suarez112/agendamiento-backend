import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import type { Sesion } from '../src/modules/auth/auth.servicio.js';
import { crearServicioClientes } from '../src/modules/clientes/clientes.servicio.js';
import { fechaEnDias } from './apoyo/baseDePrueba.js';
import {
  CLAVE_CLIENTE,
  type Contexto,
  iniciar,
  iniciarSesion,
  iniciarSesionCuenta,
  pedir,
  registrarCliente,
} from './apoyo/servidor.js';

const RUTA = '/api/v1/clientes/buscar';
const OPCION = '/api/v1/admin/empresa/privacidad-clientes';

// GET /clientes/buscar: selector de "cliente existente" para el administrador y el empleado del mismo negocio.
// El empleado solo ve (y solo busca entre) los clientes que tienen o tuvieron citas con él; su teléfono, solo con la
// opción del negocio encendida. El administrador ve y busca todos.
describe('búsqueda de clientes para el selector (admin y empleado)', () => {
  let ctx: Contexto;
  let tokenAdmin: string; // integrante con rol Administrador del negocio A
  let tokenCuentaAdmin: string; // cuenta de administración del negocio A
  let tokenEmpleado: string; // empleado del negocio A (barb_a)
  let tokenEmpleado2: string; // otro empleado del negocio A (barb_a2)
  let tokenAdminB: string; // administrador del negocio B

  const DIGITOS = '3157771234';
  const TELEFONO = `+57${DIGITOS}`;
  const PROPIO = '+573158880001';
  const CANCELADO = '+573158880002';
  const AJENO = '+573158880003';

  before(async () => {
    ctx = await iniciar();
    await ctx.pool.query(
      `INSERT INTO usuarios (correo, usuario, password_hash, rol, empresa_id) VALUES ('cuenta.sel@negocio.co', 'cuenta.sel', $1, 'admin', 'emp_a')`,
      [await bcrypt.hash('Clave-cuenta-1!', 4)],
    );
    const valores = Array.from(
      { length: 15 },
      (_, i) => `('sel_${String(i + 1).padStart(2, '0')}', 'emp_a', '+57320000${String(i + 1).padStart(4, '0')}', '57', 'Selector ${String(i + 1).padStart(2, '0')}', 1, NULL)`,
    );
    await ctx.pool.query(`
      INSERT INTO clientes (id, empresa_id, telefono, indicativo, nombre, total_citas, fecha_ultima_cita) VALUES
        ('sel_valeria', 'emp_a', '${TELEFONO}', '57', 'Valeria Gómez', 1, NULL),
        ('sel_pct', 'emp_a', '+573130000001', '57', 'Ana 100% Real_', 1, NULL),
        ('sel_otro', 'emp_b', '+573157779999', '57', 'Valeria de B', 1, NULL),
        ${valores.join(',\n')};
    `);
    // Regla de privacidad: el empleado (barb_a) solo ve a quienes tienen o tuvieron citas con él.
    // Mixto Propio: cita pendiente con barb_a. Mixto Cancelado: cita cancelada con barb_a (también cuenta).
    // Mixto Ajeno: cita solo con otro empleado del mismo negocio (barb_a2). Valeria no tiene citas.
    // Además barb_a tiene citas con los 15 "Selector NN" y con "Ana 100% Real_".
    await ctx.pool.query(`
      INSERT INTO clientes (id, empresa_id, telefono, indicativo, nombre, total_citas, fecha_ultima_cita) VALUES
        ('sel_propio', 'emp_a', '${PROPIO}', '57', 'Mixto Propio', 1, NULL),
        ('sel_cancelado', 'emp_a', '${CANCELADO}', '57', 'Mixto Cancelado', 1, NULL),
        ('sel_ajeno', 'emp_a', '${AJENO}', '57', 'Mixto Ajeno', 1, NULL);
      INSERT INTO citas (id, empresa_id, barbero_id, servicio_id, cliente_id, fecha, hora_inicio, hora_fin, precio, estado) VALUES
        ('cita_sel_propio', 'emp_a', 'barb_a', 'serv_a', 'sel_propio', '${fechaEnDias(4)}', '10:00', '10:30', 20000, 'CONFIRMADA'),
        ('cita_sel_cancelado', 'emp_a', 'barb_a', 'serv_a', 'sel_cancelado', '${fechaEnDias(4)}', '11:00', '11:30', 20000, 'CANCELADA'),
        ('cita_sel_ajeno', 'emp_a', 'barb_a2', 'serv_a', 'sel_ajeno', '${fechaEnDias(4)}', '10:00', '10:30', 20000, 'CONFIRMADA');
    `);
    const propios = [...Array.from({ length: 15 }, (_, i) => `sel_${String(i + 1).padStart(2, '0')}`), 'sel_pct'];
    const hora = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    for (const [i, cliente] of propios.entries()) {
      const inicio = 8 * 60 + i * 30;
      await ctx.pool.query(
        `INSERT INTO citas (id, empresa_id, barbero_id, servicio_id, cliente_id, fecha, hora_inicio, hora_fin, precio, estado)
         VALUES ($1, 'emp_a', 'barb_a', 'serv_a', $2, $3, $4, $5, 20000, 'CONFIRMADA')`,
        [`cita_${cliente}`, cliente, fechaEnDias(5), hora(inicio), hora(inicio + 30)],
      );
    }
    tokenAdmin = await iniciarSesion(ctx, 'admin.a', '1234');
    tokenEmpleado = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    tokenEmpleado2 = await iniciarSesion(ctx, 'barbero.a2', 'secreta');
    tokenAdminB = await iniciarSesion(ctx, 'admin.b', 'clave-b');
    tokenCuentaAdmin = (await iniciarSesionCuenta(ctx, 'cuenta.sel@negocio.co', 'Clave-cuenta-1!')).json.token;
  });
  after(() => ctx.cerrar());

  const buscar = (q: string, token: string) => pedir(ctx, `${RUTA}?q=${encodeURIComponent(q)}`, { token });
  const opcion = async (valor: boolean) => {
    const r = await pedir(ctx, OPCION, { method: 'PUT', token: tokenAdmin, body: { empleadosVenTelefono: valor } });
    assert.equal(r.estado, 200, r.texto);
  };
  const ids = (r: Awaited<ReturnType<typeof pedir>>) => r.json.datos.map((c: { id: string }) => c.id);

  test('empleado con la opción apagada: ve solo a sus clientes, con el teléfono en null (mismos campos, sin esPropio)', async () => {
    const mixtos = await buscar('mixto', tokenEmpleado);
    assert.equal(mixtos.estado, 200, mixtos.texto);
    assert.equal(mixtos.json.telefonosVisibles, false);
    assert.equal(mixtos.json.hayMas, false);
    assert.deepEqual(ids(mixtos).sort(), ['sel_cancelado', 'sel_propio']);
    for (const c of mixtos.json.datos) {
      assert.deepEqual(Object.keys(c).sort(), ['id', 'indicativo', 'nombre', 'telefono']);
      assert.equal(c.telefono, null);
      assert.equal(c.indicativo, null);
    }
    assert.ok(!mixtos.texto.replace(/\D/g, '').includes('315888000'));
    // Un cliente sin citas con él no aparece, aunque el nombre coincida
    assert.deepEqual((await buscar('valeria', tokenEmpleado)).json.datos, []);
  });

  test('empleado con la opción apagada: no puede buscar por teléfono, ni completo ni parcial ni con formato', async () => {
    for (const q of ['3158880001', PROPIO, '315888', '+57 315 888 0001', '(315) 888-0001', '888', DIGITOS, '777']) {
      const r = await buscar(q, tokenEmpleado);
      assert.equal(r.estado, 200, `${q}: ${r.texto}`);
      assert.deepEqual(r.json.datos, [], `"${q}" no debe encontrar clientes por teléfono`);
    }
  });

  test('empleado con la opción encendida: ve el teléfono de sus clientes, también si su cita se canceló', async () => {
    await opcion(true);
    try {
      const r = await buscar('mixto', tokenEmpleado);
      assert.equal(r.estado, 200, r.texto);
      assert.equal(r.json.telefonosVisibles, true);
      assert.deepEqual(ids(r).sort(), ['sel_cancelado', 'sel_propio']);
      const porId = Object.fromEntries(r.json.datos.map((c: { id: string }) => [c.id, c]));
      assert.deepEqual(porId.sel_propio, { id: 'sel_propio', nombre: 'Mixto Propio', telefono: PROPIO, indicativo: '57' });
      assert.deepEqual(porId.sel_cancelado, { id: 'sel_cancelado', nombre: 'Mixto Cancelado', telefono: CANCELADO, indicativo: '57' });
      // Busca por teléfono, completo y parcial, entre sus clientes
      for (const q of [PROPIO, '3158880001', '315888000', '+57 315 888 0001']) {
        assert.ok(ids(await buscar(q, tokenEmpleado)).includes('sel_propio'), `"${q}" encuentra a su cliente`);
      }
      assert.deepEqual(ids(await buscar('3158880001', tokenEmpleado)), ['sel_propio']);
    } finally {
      await opcion(false);
    }
  });

  test('empleado, apagada o encendida: un cliente ajeno o sin citas no aparece, ni por nombre ni por teléfono', async () => {
    for (const encendida of [false, true]) {
      await opcion(encendida);
      try {
        for (const q of ['ajeno', 'mixto ajeno', 'valeria', 'Valeria Gómez']) {
          const r = await buscar(q, tokenEmpleado);
          assert.equal(r.estado, 200, `${q}: ${r.texto}`);
          assert.deepEqual(r.json.datos, [], `"${q}" no debe devolver clientes que no son suyos`);
        }
        for (const q of ['3158880003', AJENO, '888 0003', DIGITOS, '315777']) {
          const r = await buscar(q, tokenEmpleado);
          assert.equal(r.estado, 200, `${q}: ${r.texto}`);
          assert.deepEqual(r.json.datos, [], `"${q}" no debe revelar a un cliente ajeno por su teléfono`);
          assert.ok(!r.texto.replace(/\D/g, '').includes('3158880003'));
        }
        // Sin oráculo: el teléfono ajeno completo responde lo mismo que uno que no existe
        assert.deepEqual((await buscar('3158880003', tokenEmpleado)).json, (await buscar('3159999999', tokenEmpleado)).json);
        // Una búsqueda que mezcla propios y ajenos solo trae a los propios
        assert.deepEqual(ids(await buscar('mixto', tokenEmpleado)).sort(), ['sel_cancelado', 'sel_propio']);
      } finally {
        await opcion(false);
      }
    }
  });

  test('la relación es con cada empleado: el otro empleado ve solo a Mixto Ajeno (y su teléfono solo con la opción encendida)', async () => {
    await opcion(true);
    try {
      const r = await buscar('mixto', tokenEmpleado2);
      assert.equal(r.estado, 200, r.texto);
      assert.deepEqual(r.json.datos, [{ id: 'sel_ajeno', nombre: 'Mixto Ajeno', telefono: AJENO, indicativo: '57' }]);
      assert.deepEqual(ids(await buscar('3158880001', tokenEmpleado2)), []);
      assert.deepEqual(ids(await buscar('3158880003', tokenEmpleado2)), ['sel_ajeno']);
    } finally {
      await opcion(false);
    }
    // Apagada, en la siguiente solicitud y con el mismo token: sigue viendo a sus clientes, sin teléfono
    const apagada = await buscar('mixto', tokenEmpleado);
    assert.deepEqual(ids(apagada).sort(), ['sel_cancelado', 'sel_propio']);
    assert.ok(apagada.json.datos.every((c: { telefono: unknown }) => c.telefono === null));
    assert.deepEqual((await buscar('3158880003', tokenEmpleado2)).json.datos, []);
  });

  test('los administradores ven el teléfono y buscan por teléfono aunque la opción esté apagada', async () => {
    for (const token of [tokenAdmin, tokenCuentaAdmin]) {
      const porNombre = await buscar('valeria', token);
      assert.equal(porNombre.estado, 200, porNombre.texto);
      assert.equal(porNombre.json.telefonosVisibles, true);
      assert.deepEqual(porNombre.json.datos, [{ id: 'sel_valeria', nombre: 'Valeria Gómez', telefono: TELEFONO, indicativo: '57' }]);
      const porTelefono = await buscar('315777', token);
      assert.deepEqual(ids(porTelefono), ['sel_valeria']);
      // Ve y busca los teléfonos de todos los clientes, tengan o no citas con un empleado
      const mixtos = await buscar('mixto', token);
      assert.deepEqual(
        mixtos.json.datos.map((c: { id: string; telefono: string }) => [c.id, c.telefono]).sort(),
        [['sel_ajeno', AJENO], ['sel_cancelado', CANCELADO], ['sel_propio', PROPIO]],
      );
      assert.deepEqual(ids(await buscar('3158880003', token)), ['sel_ajeno']);
      // Un número con ceros seguidos también se busca (no se confunde con un carácter no válido)
      const conCeros = await buscar('3200000001', token);
      assert.equal(conCeros.estado, 200, conCeros.texto);
      assert.deepEqual(ids(conCeros), ['sel_01']);
    }
  });

  test('el administrador mantiene su acceso de siempre a GET /clientes; el empleado sigue sin él', async () => {
    const admin = await pedir(ctx, '/api/v1/clientes', { token: tokenAdmin });
    assert.equal(admin.estado, 200, admin.texto);
    assert.ok(admin.json.some((c: { id: string; telefono: string }) => c.id === 'sel_valeria' && c.telefono === TELEFONO));
    const empleado = await pedir(ctx, '/api/v1/clientes', { token: tokenEmpleado });
    assert.equal(empleado.estado, 403, empleado.texto);
  });

  test('solo clientes del negocio de la sesión: ni por nombre ni por teléfono aparecen los de otro negocio', async () => {
    const a = await buscar('valeria', tokenAdmin);
    assert.deepEqual(ids(a), ['sel_valeria']);
    const b = await buscar('valeria', tokenAdminB);
    assert.equal(b.estado, 200, b.texto);
    assert.deepEqual(ids(b), ['sel_otro']);
    const bPorTelefono = await buscar(DIGITOS, tokenAdminB);
    assert.deepEqual(bPorTelefono.json.datos, []);
    // Un empresaId en la URL no cambia el negocio: sale de la sesión
    const forzado = await pedir(ctx, `${RUTA}?q=mixto&empresaId=emp_b`, { token: tokenEmpleado });
    assert.equal(forzado.estado, 200, forzado.texto);
    assert.deepEqual(ids(forzado).sort(), ['sel_cancelado', 'sel_propio']);
  });

  test('máximo 10 resultados por búsqueda, con hayMas cuando hay más coincidencias', async () => {
    for (const token of [tokenAdmin, tokenEmpleado]) {
      const r = await buscar('selector', token);
      assert.equal(r.estado, 200, r.texto);
      assert.equal(r.json.datos.length, 10);
      assert.equal(r.json.hayMas, true);
    }
    // Un "limite" en la URL no amplía el máximo
    const ampliado = await pedir(ctx, `${RUTA}?q=selector&limite=50`, { token: tokenAdmin });
    assert.equal(ampliado.estado, 200, ampliado.texto);
    assert.equal(ampliado.json.datos.length, 10);
    // Con 10 o menos coincidencias, hayMas es false
    const justo = await buscar('selector 1', tokenAdmin);
    assert.deepEqual(ids(justo).sort(), ['sel_10', 'sel_11', 'sel_12', 'sel_13', 'sel_14', 'sel_15']);
    assert.equal(justo.json.hayMas, false);
  });

  test('exige al menos 3 caracteres (sin contar espacios) y como máximo 100', async () => {
    const MINIMO = 'Escribe al menos 3 caracteres para buscar';
    for (const ruta of [RUTA, `${RUTA}?q=`, `${RUTA}?q=ab`, `${RUTA}?q=${encodeURIComponent('  ab  ')}`]) {
      for (const token of [tokenAdmin, tokenEmpleado]) {
        const r = await pedir(ctx, ruta, { token });
        assert.equal(r.estado, 400, `${ruta}: ${r.texto}`);
        assert.deepEqual(r.json, { error: MINIMO });
      }
    }
    const largo = await buscar('a'.repeat(101), tokenAdmin);
    assert.equal(largo.estado, 400);
    assert.deepEqual(largo.json, { error: 'La búsqueda puede tener hasta 100 caracteres' });
    // Los espacios de los extremos tampoco cuentan para el máximo
    const conEspacios = await buscar(`  ${'a'.repeat(100)}  `, tokenAdmin);
    assert.equal(conEspacios.estado, 200, conEspacios.texto);
    const repetido = await pedir(ctx, `${RUTA}?q=valeria&q=ana`, { token: tokenAdmin });
    assert.equal(repetido.estado, 400);
    assert.deepEqual(repetido.json, { error: 'La búsqueda debe ser un texto' });
    const nulo = await pedir(ctx, `${RUTA}?q=val%00eria`, { token: tokenAdmin });
    assert.equal(nulo.estado, 400);
    assert.deepEqual(nulo.json, { error: 'La búsqueda debe ser un texto' });
  });

  test('por teléfono hacen falta al menos 3 dígitos: "+57" no trae a todos los clientes', async () => {
    const r = await buscar('+57', tokenAdmin);
    assert.equal(r.estado, 200, r.texto);
    assert.deepEqual(r.json.datos, []);
  });

  test('los comodines se buscan como texto: "%%%" o "___" no traen a todos', async () => {
    assert.deepEqual(ids(await buscar('%%%', tokenAdmin)), []);
    assert.deepEqual(ids(await buscar('___', tokenAdmin)), []);
    assert.deepEqual(ids(await buscar('100%', tokenEmpleado)), ['sel_pct']);
  });

  test('sin sesión del personal no responde: sin token 401, cuenta de cliente 403', async () => {
    const sinToken = await pedir(ctx, `${RUTA}?q=valeria`);
    assert.equal(sinToken.estado, 401);
    await registrarCliente(ctx, 'selector@correo.com', CLAVE_CLIENTE);
    const cliente = (await iniciarSesionCuenta(ctx, 'selector@correo.com', CLAVE_CLIENTE)).json.token;
    const r = await pedir(ctx, `${RUTA}?q=valeria`, { token: cliente });
    assert.equal(r.estado, 403, r.texto);
    assert.ok(!r.texto.includes('Valeria'));
  });

  test('niega por defecto: un empleado sin profesional asociado no ve ningún cliente, aunque la opción esté encendida', async () => {
    // El tipo Sesion impide esta sesión; se fuerza para comprobar que no cae a la visibilidad de administrador
    const sinProfesional = { barberoId: null, usuarioId: null, empresaId: 'emp_a', esAdmin: false } as unknown as Sesion;
    const servicio = crearServicioClientes({ pool: ctx.pool });
    await opcion(true);
    try {
      for (const q of ['mixto', 'valeria', '3158880001', DIGITOS]) {
        assert.deepEqual(await servicio.buscarParaSelector(sinProfesional, q), { datos: [], hayMas: false, telefonosVisibles: false });
      }
    } finally {
      await opcion(false);
    }
  });

  test('con la suscripción del negocio vencida responde 402, también al administrador', async () => {
    const antes = (await ctx.pool.query("SELECT estado_suscripcion, trial_ends_at FROM empresas WHERE id = 'emp_a'")).rows[0];
    await ctx.pool.query("UPDATE empresas SET estado_suscripcion = 'trial', trial_ends_at = now() - interval '1 minute' WHERE id = 'emp_a'");
    try {
      for (const token of [tokenAdmin, tokenEmpleado]) {
        const r = await buscar('valeria', token);
        assert.equal(r.estado, 402, r.texto);
        assert.ok(!r.texto.includes('Valeria'));
      }
    } finally {
      await ctx.pool.query('UPDATE empresas SET estado_suscripcion = $1, trial_ends_at = $2 WHERE id = $3', [
        antes.estado_suscripcion,
        antes.trial_ends_at,
        'emp_a',
      ]);
    }
    assert.equal((await buscar('valeria', tokenEmpleado)).estado, 200);
  });
});
