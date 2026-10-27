import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fechaEnDias } from './apoyo/baseDePrueba.js';
import {
  CLAVE_CLIENTE,
  type Contexto,
  esperarHasta,
  iniciar,
  iniciarSesion,
  pedir,
  registrarCliente,
  reservaValida,
} from './apoyo/servidor.js';

// Un negocio nunca ve ni modifica datos de otro. El administrador del negocio A intenta leer y cambiar,
// por su identificador, lo que es del negocio B en cada endpoint de gestión; cada intento debe responder
// 404 (como si no existiera) y los datos de B deben quedar exactamente igual.
describe('aislamiento entre negocios', () => {
  let ctx: Contexto;
  let tokenA: string;
  let tokenB: string;
  let productoB: string;
  let bloqueoB: string;
  let listaNegraB: string;

  before(async () => {
    ctx = await iniciar();
    tokenA = await iniciarSesion(ctx, 'admin.a', '1234');
    tokenB = await iniciarSesion(ctx, 'admin.b', 'clave-b');

    const producto = await pedir(ctx, '/api/v1/productos', { method: 'POST', token: tokenB, body: { nombre: 'Cera B', precio: 30000 } });
    const bloqueo = await pedir(ctx, '/api/v1/bloqueos', {
      method: 'POST',
      token: tokenB,
      body: { barberoId: 'admin_b', diaSemana: 1, horaInicio: '12:00', horaFin: '13:00', motivo: 'Almuerzo de B' },
    });
    const listaNegra = await pedir(ctx, '/api/v1/clientes/lista-negra', { method: 'POST', token: tokenB, body: { clienteId: 'cli_b' } });
    assert.deepEqual([producto.estado, bloqueo.estado, listaNegra.estado], [201, 201, 201]);
    [productoB, bloqueoB, listaNegraB] = [producto.json.id, bloqueo.json.id, listaNegra.json.id];
  });
  after(() => ctx.cerrar());

  const consulta = async (sql: string, valores: unknown[] = []) => (await ctx.pool.query(sql, valores)).rows;

  test('el equipo de B no aparece ni se puede cambiar, quitar ni fotografiar desde A', async () => {
    const lista = await pedir(ctx, '/api/v1/equipo', { token: tokenA });
    assert.equal(lista.estado, 200);
    assert.deepEqual(lista.json.map((m: { id: string }) => m.id).sort(), ['admin_a', 'barb_a', 'barb_a2']);

    const antes = await consulta("SELECT nombre, especialidad, porcentaje_ganancia, activo, es_admin FROM barberos WHERE id = 'admin_b'");
    const cambiar = await pedir(ctx, '/api/v1/equipo/admin_b', { method: 'PATCH', token: tokenA, body: { nombre: 'Hackeado', especialidad: 'x' } });
    const quitar = await pedir(ctx, '/api/v1/equipo/admin_b', { method: 'DELETE', token: tokenA });
    assert.deepEqual([cambiar.estado, quitar.estado], [404, 404]);
    assert.deepEqual(cambiar.json, { error: 'Profesional no encontrado' });
    assert.deepEqual(await consulta("SELECT nombre, especialidad, porcentaje_ganancia, activo, es_admin FROM barberos WHERE id = 'admin_b'"), antes);
  });

  test('los servicios de B no aparecen ni se pueden cambiar o eliminar desde A', async () => {
    const lista = await pedir(ctx, '/api/v1/servicios', { token: tokenA });
    assert.deepEqual(lista.json.map((s: { id: string }) => s.id).sort(), ['serv_a', 'serv_a_largo']);

    const antes = await consulta("SELECT nombre, precio, duracion_min, activo FROM servicios WHERE id = 'serv_b'");
    const cambiar = await pedir(ctx, '/api/v1/servicios/serv_b', { method: 'PATCH', token: tokenA, body: { precio: 1 } });
    const eliminar = await pedir(ctx, '/api/v1/servicios/serv_b', { method: 'DELETE', token: tokenA });
    assert.deepEqual([cambiar.estado, eliminar.estado], [404, 404]);
    assert.deepEqual(cambiar.json, { error: 'Servicio no encontrado' });
    assert.deepEqual(await consulta("SELECT nombre, precio, duracion_min, activo FROM servicios WHERE id = 'serv_b'"), antes);
  });

  test('los productos de B no aparecen ni se pueden cambiar, eliminar o fotografiar desde A', async () => {
    const lista = await pedir(ctx, '/api/v1/productos', { token: tokenA });
    assert.equal(lista.estado, 200);
    assert.ok(!lista.json.some((p: { id: string }) => p.id === productoB));

    const cambiar = await pedir(ctx, `/api/v1/productos/${productoB}`, { method: 'PATCH', token: tokenA, body: { precio: 1 } });
    const eliminar = await pedir(ctx, `/api/v1/productos/${productoB}`, { method: 'DELETE', token: tokenA });
    const quitarFoto = await pedir(ctx, `/api/v1/productos/${productoB}/foto`, { method: 'DELETE', token: tokenA });
    assert.deepEqual([cambiar.estado, eliminar.estado, quitarFoto.estado], [404, 404, 404]);
    assert.deepEqual(await consulta('SELECT nombre, precio::int AS precio FROM productos WHERE id = $1', [productoB]), [{ nombre: 'Cera B', precio: 30000 }]);
  });

  test('los clientes y la lista negra de B no se ven ni se tocan desde A', async () => {
    const clientes = await pedir(ctx, '/api/v1/clientes', { token: tokenA });
    assert.equal(clientes.estado, 200);
    assert.ok(!clientes.texto.includes('cli_b') && !clientes.texto.includes('Cliente de B'));

    const historial = await pedir(ctx, '/api/v1/clientes/cli_b/historial', { token: tokenA });
    assert.equal(historial.estado, 404);
    assert.deepEqual(historial.json, { error: 'Cliente no encontrado' });

    const listaA = await pedir(ctx, '/api/v1/clientes/lista-negra', { token: tokenA });
    assert.deepEqual(listaA.json, []);
    const agregar = await pedir(ctx, '/api/v1/clientes/lista-negra', { method: 'POST', token: tokenA, body: { clienteId: 'cli_b' } });
    assert.equal(agregar.estado, 404);
    const quitar = await pedir(ctx, `/api/v1/clientes/lista-negra/${listaNegraB}`, { method: 'DELETE', token: tokenA });
    assert.equal(quitar.estado, 404);
    assert.deepEqual(await consulta('SELECT empresa_id FROM lista_negra WHERE id = $1', [listaNegraB]), [{ empresa_id: 'emp_b' }]);
    assert.deepEqual(await consulta("SELECT count(*)::int AS n FROM lista_negra WHERE empresa_id = 'emp_a'"), [{ n: 0 }]);
  });

  test('los bloqueos de B no se ven, no se borran y no se crean sobre un profesional de B', async () => {
    const lista = await pedir(ctx, '/api/v1/bloqueos', { token: tokenA });
    assert.deepEqual(lista.json, []);
    const calendario = await pedir(ctx, `/api/v1/bloqueos/calendario?desde=${fechaEnDias(0)}&hasta=${fechaEnDias(10)}&barberoId=admin_b`, { token: tokenA });
    assert.ok(!calendario.texto.includes('cita_b') && !calendario.texto.includes('Almuerzo de B'));

    const borrar = await pedir(ctx, `/api/v1/bloqueos/${bloqueoB}`, { method: 'DELETE', token: tokenA });
    assert.equal(borrar.estado, 404);
    assert.deepEqual(borrar.json, { error: 'Bloqueo no encontrado' });
    const crear = await pedir(ctx, '/api/v1/bloqueos', {
      method: 'POST',
      token: tokenA,
      body: { barberoId: 'admin_b', diaSemana: 2, horaInicio: '10:00', horaFin: '11:00' },
    });
    assert.equal(crear.estado, 404);
    assert.deepEqual(crear.json, { error: 'Profesional no encontrado' });
    assert.deepEqual(await consulta("SELECT count(*)::int AS n FROM bloqueos WHERE barbero_id = 'admin_b'"), [{ n: 1 }]);
  });

  test('la cartera y los reportes de A no incluyen ventas de B aunque pida un profesional de B', async () => {
    // B completa su cita: ahora B tiene ventas
    const completar = await pedir(ctx, '/api/v1/citas/cita_b/completar', { method: 'PATCH', token: tokenB });
    assert.equal(completar.estado, 200, completar.texto);
    const filtro = `desde=${fechaEnDias(-30)}&hasta=${fechaEnDias(30)}`;

    const propia = await pedir(ctx, `/api/v1/cartera?${filtro}`, { token: tokenB });
    assert.equal(propia.json.totalVentas, 18000, 'B sí ve sus propias ventas');

    const sinFiltro = await pedir(ctx, `/api/v1/cartera?${filtro}`, { token: tokenA });
    assert.equal(sinFiltro.estado, 200);
    assert.equal(sinFiltro.json.totalVentas, 0);
    assert.equal(sinFiltro.json.totalCitas, 0);
    assert.ok(!sinFiltro.texto.includes('Admin B'));

    // Los reportes dependen del plan: A usa el nivel Pro para que el plan no responda antes que la validación
    await ctx.pool.query("UPDATE empresas SET plan_equipo = 'pro' WHERE id = 'emp_a'");

    // Pedir un profesional de otro negocio responde 404, como el resto de los endpoints
    const ajenas = [
      `/api/v1/cartera?${filtro}&barberoId=admin_b`,
      `/api/v1/cartera/resumen?periodo=rango&desde=${fechaEnDias(0)}&hasta=${fechaEnDias(0)}&barberoId=admin_b`,
      `/api/v1/cartera/resumen?periodo=mes&barberoId=admin_b`,
      '/api/v1/reportes/servicios-rentables?periodo=mes&barberoId=admin_b',
      '/api/v1/reportes/ocupacion?periodo=mes&barberoId=admin_b',
      '/api/v1/reportes/demanda?periodo=mes&barberoId=admin_b',
    ];
    for (const ruta of ajenas) {
      const r = await pedir(ctx, ruta, { token: tokenA });
      assert.equal(r.estado, 404, ruta);
      assert.deepEqual(r.json, { error: 'Profesional no encontrado' }, ruta);
      assert.ok(!r.texto.includes('Admin B') && !r.texto.includes('Corte B'), ruta);
    }
    // Un profesional del propio negocio sigue funcionando
    const propio = await pedir(ctx, `/api/v1/cartera?${filtro}&barberoId=barb_a`, { token: tokenA });
    assert.equal(propio.estado, 200);
    assert.equal(propio.json.barberoId, 'barb_a');
  });

  test('no se puede pedir horas ni reservar mezclando negocios', async () => {
    const fecha = fechaEnDias(3);
    const combos = [
      `empresaId=emp_a&barberoId=admin_b&servicioId=serv_a&fecha=${fecha}`,
      `empresaId=emp_a&barberoId=barb_a&servicioId=serv_b&fecha=${fecha}`,
      `empresaId=emp_b&barberoId=barb_a&servicioId=serv_b&fecha=${fecha}`,
    ];
    for (const combo of combos) {
      const r = await pedir(ctx, `/api/v1/citas/disponibilidad?${combo}`);
      assert.equal(r.estado, 404, combo);
      assert.deepEqual(r.json, { error: 'Servicio o profesional no encontrado' });
    }
    const citas = await consulta('SELECT count(*)::int AS n FROM citas');
    for (const cambios of [{ empresaId: 'emp_b' }, { empresaId: 'emp_a', barberoId: 'admin_b' }, { servicioId: 'serv_b' }]) {
      const r = await pedir(ctx, '/api/v1/citas', { method: 'POST', body: reservaValida({ fecha, ...cambios }) });
      assert.equal(r.estado, 404, JSON.stringify(cambios));
    }
    assert.deepEqual(await consulta('SELECT count(*)::int AS n FROM citas'), citas);
  });

  test('cada negocio ve solo su propia información de negocio', async () => {
    const a = await pedir(ctx, '/api/v1/empresas/actual', { token: tokenA });
    const b = await pedir(ctx, '/api/v1/empresas/actual', { token: tokenB });
    assert.equal(a.json.empresa.id, 'emp_a');
    assert.equal(b.json.empresa.id, 'emp_b');
    assert.ok(!a.texto.includes('admin.b') && !b.texto.includes('admin.a'));
    const miNegocioA = await pedir(ctx, '/api/v1/admin/empresa', { token: tokenA });
    const miNegocioB = await pedir(ctx, '/api/v1/admin/empresa', { token: tokenB });
    assert.deepEqual([miNegocioA.json.id, miNegocioB.json.id], ['emp_a', 'emp_b']);
  });

  test('un cliente con cuenta no puede cancelar, reprogramar ni ver el historial de la cita de otro cliente', async () => {
    const dueno = await registrarCliente(ctx, 'dueno@correo.com', CLAVE_CLIENTE);
    const intruso = await registrarCliente(ctx, 'intruso@correo.com', CLAVE_CLIENTE);
    assert.deepEqual([dueno.estado, intruso.estado], [201, 201]);
    const fecha = fechaEnDias(4);
    const cita = await pedir(ctx, '/api/v1/citas', { method: 'POST', token: dueno.json.token, body: reservaValida({ fecha, hora: '09:00 AM' }) });
    assert.equal(cita.estado, 201, cita.texto);
    const id = cita.json.cita.id;

    const cancelar = await pedir(ctx, `/api/v1/mi-cuenta/citas/${id}/cancelar`, { method: 'PATCH', token: intruso.json.token });
    const reprogramar = await pedir(ctx, `/api/v1/mi-cuenta/citas/${id}/reprogramar`, {
      method: 'PATCH',
      token: intruso.json.token,
      body: { fecha: fechaEnDias(5), hora: '10:00 AM' },
    });
    const historial = await pedir(ctx, `/api/v1/mi-cuenta/citas/${id}/historial`, { token: intruso.json.token });
    assert.deepEqual([cancelar.estado, reprogramar.estado, historial.estado], [409, 404, 404]);
    const suyas = await pedir(ctx, '/api/v1/mi-cuenta/citas', { token: intruso.json.token });
    assert.deepEqual(suyas.json, []);
    assert.deepEqual(await consulta('SELECT estado, fecha::text AS fecha FROM citas WHERE id = $1', [id]), [{ estado: 'CONFIRMADA', fecha }]);

    // El dueño sí puede reprogramarla y cancelarla
    const propia = await pedir(ctx, `/api/v1/mi-cuenta/citas/${id}/reprogramar`, {
      method: 'PATCH',
      token: dueno.json.token,
      body: { fecha: fechaEnDias(5), hora: '10:00 AM' },
    });
    assert.equal(propia.estado, 200, propia.texto);
  });

  test('las notificaciones de un negocio no las ve ni las marca otro', async () => {
    const cita = await pedir(ctx, '/api/v1/citas', { method: 'POST', body: reservaValida({ fecha: fechaEnDias(6), hora: '03:00 PM', telefono: '3100000099' }) });
    assert.equal(cita.estado, 201);
    // El aviso de la cita nueva se guarda sin esperar la respuesta de la reserva
    const aviso = await esperarHasta(async () => {
      const r = await pedir(ctx, '/api/v1/notificaciones', { token: tokenA });
      return r.json.datos.find((n: { tipo: string }) => n.tipo === 'cita_nueva');
    });
    const deB = await pedir(ctx, '/api/v1/notificaciones', { token: tokenB });
    assert.ok(!deB.json.datos.some((n: { id: string }) => n.id === aviso.id));

    const marcar = await pedir(ctx, `/api/v1/notificaciones/${aviso.id}/leida`, { method: 'PATCH', token: tokenB });
    assert.equal(marcar.estado, 404);
    assert.deepEqual(marcar.json, { error: 'Notificación no encontrada' });
    const todas = await pedir(ctx, '/api/v1/notificaciones/leidas', { method: 'PATCH', token: tokenB });
    assert.equal(todas.estado, 200);
    assert.deepEqual(await consulta('SELECT leida_en IS NULL AS sin_leer FROM notificaciones WHERE id = $1', [aviso.id]), [{ sin_leer: true }]);
    assert.equal((await pedir(ctx, `/api/v1/notificaciones/${aviso.id}/leida`, { method: 'PATCH', token: tokenA })).estado, 200);
  });
});
