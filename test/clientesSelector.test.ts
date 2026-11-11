import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
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
// El empleado ve siempre el nombre; el teléfono (y la búsqueda por teléfono) solo con la opción del negocio encendida.
describe('búsqueda de clientes para el selector (admin y empleado)', () => {
  let ctx: Contexto;
  let tokenAdmin: string; // integrante con rol Administrador del negocio A
  let tokenCuentaAdmin: string; // cuenta de administración del negocio A
  let tokenEmpleado: string; // empleado del negocio A
  let tokenAdminB: string; // administrador del negocio B

  const DIGITOS = '3157771234';
  const TELEFONO = `+57${DIGITOS}`;

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
    tokenAdmin = await iniciarSesion(ctx, 'admin.a', '1234');
    tokenEmpleado = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
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

  test('empleado con la opción apagada: ve el nombre y el teléfono llega en null (mismos campos)', async () => {
    const r = await buscar('valeria', tokenEmpleado);
    assert.equal(r.estado, 200, r.texto);
    assert.equal(r.json.telefonosVisibles, false);
    assert.equal(r.json.hayMas, false);
    assert.deepEqual(r.json.datos, [{ id: 'sel_valeria', nombre: 'Valeria Gómez', telefono: null, indicativo: null }]);
    assert.ok(!r.texto.replace(/\D/g, '').includes(DIGITOS), 'la respuesta no trae los dígitos del teléfono');
  });

  test('empleado con la opción apagada: no puede buscar por teléfono, ni completo ni parcial ni con formato', async () => {
    for (const q of [DIGITOS, TELEFONO, '315777', '+57 315 777 1234', '(315) 777-1234', '777']) {
      const r = await buscar(q, tokenEmpleado);
      assert.equal(r.estado, 200, `${q}: ${r.texto}`);
      assert.deepEqual(r.json.datos, [], `"${q}" no debe encontrar clientes por teléfono`);
    }
  });

  test('empleado con la opción encendida: ve el teléfono y puede buscar por teléfono (también parcial)', async () => {
    await opcion(true);
    try {
      const porNombre = await buscar('valeria', tokenEmpleado);
      assert.equal(porNombre.estado, 200, porNombre.texto);
      assert.equal(porNombre.json.telefonosVisibles, true);
      assert.deepEqual(porNombre.json.datos, [{ id: 'sel_valeria', nombre: 'Valeria Gómez', telefono: TELEFONO, indicativo: '57' }]);
      for (const q of [DIGITOS, '315777', '+57 315 777 1234']) {
        const r = await buscar(q, tokenEmpleado);
        assert.equal(r.estado, 200, r.texto);
        assert.deepEqual(ids(r), ['sel_valeria'], `"${q}" encuentra al cliente por teléfono`);
      }
    } finally {
      await opcion(false);
    }
    // Al apagarla, en la siguiente solicitud y con el mismo token, vuelve a ocultarse
    const r = await buscar(DIGITOS, tokenEmpleado);
    assert.deepEqual(r.json.datos, []);
  });

  test('los administradores ven el teléfono y buscan por teléfono aunque la opción esté apagada', async () => {
    for (const token of [tokenAdmin, tokenCuentaAdmin]) {
      const porNombre = await buscar('valeria', token);
      assert.equal(porNombre.estado, 200, porNombre.texto);
      assert.equal(porNombre.json.telefonosVisibles, true);
      assert.deepEqual(porNombre.json.datos, [{ id: 'sel_valeria', nombre: 'Valeria Gómez', telefono: TELEFONO, indicativo: '57' }]);
      const porTelefono = await buscar('315777', token);
      assert.deepEqual(ids(porTelefono), ['sel_valeria']);
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
    const forzado = await pedir(ctx, `${RUTA}?q=valeria&empresaId=emp_b`, { token: tokenEmpleado });
    assert.equal(forzado.estado, 200, forzado.texto);
    assert.deepEqual(ids(forzado), ['sel_valeria']);
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
});
