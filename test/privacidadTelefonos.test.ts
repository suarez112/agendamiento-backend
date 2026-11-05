import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { fechaEnDias } from './apoyo/baseDePrueba.js';
import {
  type Contexto,
  esperarHasta,
  iniciar,
  iniciarSesion,
  iniciarSesionCuenta,
  pedir,
  reservaValida,
} from './apoyo/servidor.js';

const RUTA = '/api/v1/admin/empresa/privacidad-clientes';

// Opción "los empleados pueden ver el teléfono de los clientes": apagada por defecto, solo la cambia un administrador
describe('opción del negocio: teléfono de los clientes para los empleados', () => {
  let ctx: Contexto;
  let tokenAdmin: string; // integrante con rol Administrador
  let tokenCuentaAdmin: string; // cuenta de administración (correo)
  let tokenEmpleado: string;
  let tokenAdminB: string;

  before(async () => {
    ctx = await iniciar();
    await ctx.pool.query(
      `INSERT INTO usuarios (correo, usuario, password_hash, rol, empresa_id) VALUES ('cuenta.a@negocio.co', 'cuenta.a', $1, 'admin', 'emp_a')`,
      [await bcrypt.hash('Clave-cuenta-1!', 4)],
    );
    tokenAdmin = await iniciarSesion(ctx, 'admin.a', '1234');
    tokenEmpleado = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    tokenAdminB = await iniciarSesion(ctx, 'admin.b', 'clave-b');
    tokenCuentaAdmin = (await iniciarSesionCuenta(ctx, 'cuenta.a@negocio.co', 'Clave-cuenta-1!')).json.token;
  });
  after(() => ctx.cerrar());

  const cambiar = (token: string, body: unknown) => pedir(ctx, RUTA, { method: 'PUT', token, body });

  test('está apagada por defecto, también en los negocios que ya existían', async () => {
    const r = await pedir(ctx, RUTA, { token: tokenAdmin });
    assert.equal(r.estado, 200, r.texto);
    assert.deepEqual(r.json, { empleadosVenTelefono: false });
    const columna = await ctx.pool.query('SELECT count(*)::int AS n FROM empresas WHERE empleados_ven_telefono');
    assert.equal(columna.rows[0].n, 0);
  });

  test('un integrante administrador y la cuenta de administración la cambian', async () => {
    const encender = await cambiar(tokenAdmin, { empleadosVenTelefono: true });
    assert.equal(encender.estado, 200, encender.texto);
    assert.deepEqual(encender.json, {
      mensaje: 'Ahora los empleados pueden ver el teléfono de los clientes',
      empleadosVenTelefono: true,
    });
    assert.deepEqual((await pedir(ctx, RUTA, { token: tokenCuentaAdmin })).json, { empleadosVenTelefono: true });

    const apagar = await cambiar(tokenCuentaAdmin, { empleadosVenTelefono: false });
    assert.equal(apagar.estado, 200, apagar.texto);
    assert.deepEqual(apagar.json, {
      mensaje: 'Los empleados ya no ven el teléfono de los clientes',
      empleadosVenTelefono: false,
    });
    const fila = await ctx.pool.query("SELECT empleados_ven_telefono FROM empresas WHERE id = 'emp_a'");
    assert.equal(fila.rows[0].empleados_ven_telefono, false);
  });

  test('un empleado no la puede ver ni cambiar (403) y no cambia nada', async () => {
    const ver = await pedir(ctx, RUTA, { token: tokenEmpleado });
    assert.equal(ver.estado, 403);
    assert.equal(ver.json.error, 'Solo el administrador del negocio puede usar esta función.');
    const cambio = await cambiar(tokenEmpleado, { empleadosVenTelefono: true });
    assert.equal(cambio.estado, 403);
    const fila = await ctx.pool.query("SELECT empleados_ven_telefono FROM empresas WHERE id = 'emp_a'");
    assert.equal(fila.rows[0].empleados_ven_telefono, false);
    assert.equal((await pedir(ctx, RUTA)).estado, 401);
  });

  test('cada administrador cambia solo su propio negocio', async () => {
    assert.equal((await cambiar(tokenAdminB, { empleadosVenTelefono: true })).estado, 200);
    const filas = await ctx.pool.query("SELECT id, empleados_ven_telefono AS v FROM empresas WHERE id IN ('emp_a', 'emp_b') ORDER BY id");
    assert.deepEqual(filas.rows, [{ id: 'emp_a', v: false }, { id: 'emp_b', v: true }]);
    assert.equal((await cambiar(tokenAdminB, { empleadosVenTelefono: false })).estado, 200);
  });

  test('valida el cuerpo antes de cambiar nada', async () => {
    for (const body of [{}, { empleadosVenTelefono: 'si' }, { empleadosVenTelefono: 1 }, { empleadosVenTelefono: null }]) {
      const r = await cambiar(tokenAdmin, body);
      assert.equal(r.estado, 400, JSON.stringify(body));
      assert.equal(r.json.error, 'Envía "empleadosVenTelefono": true o false');
    }
  });
});

// Barrido (S3, S4): con la opción apagada, ninguna respuesta que puede pedir un empleado trae el teléfono ni el
// WhatsApp de un cliente. Encendida, sí. Los administradores siempre lo ven. El cambio aplica en la siguiente solicitud.
describe('barrido: el teléfono de los clientes no llega a un empleado sin permiso', () => {
  let ctx: Contexto;
  let tokenAdmin: string;
  let tokenCuentaAdmin: string;
  let tokenEmpleado: string;

  // Cliente conocido del negocio A con citas con el empleado barb_a
  const DIGITOS = '3156667788';
  const TELEFONO = `+57${DIGITOS}`;
  const CLIENTE = 'cli_privado';
  const CITA = 'cita_privada';
  const FECHA = fechaEnDias(3);

  // Horas libres de ese día para las citas del panel (de 30 en 30, sin las 09:00 ni las 04:00 PM, ya ocupadas)
  const horasLibres = Array.from({ length: 24 }, (_, i) => 8 * 60 + i * 30)
    .filter((m) => m !== 9 * 60 && m !== 16 * 60)
    .map((m) => {
      const h = Math.floor(m / 60);
      return `${String(((h + 11) % 12) + 1).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
    });

  before(async () => {
    ctx = await iniciar();
    await ctx.pool.query(
      `INSERT INTO usuarios (correo, usuario, password_hash, rol, empresa_id) VALUES ('cuenta.b@negocio.co', 'cuenta.ba', $1, 'admin', 'emp_a')`,
      [await bcrypt.hash('Clave-cuenta-1!', 4)],
    );
    await ctx.pool.query(
      `INSERT INTO clientes (id, empresa_id, telefono, indicativo, nombre, total_citas, fecha_ultima_cita)
       VALUES ($1, 'emp_a', $2, '57', 'Cliente Privado', 1, $3)`,
      [CLIENTE, TELEFONO, FECHA],
    );
    await ctx.pool.query(
      `INSERT INTO citas (id, empresa_id, barbero_id, servicio_id, cliente_id, fecha, hora_inicio, hora_fin, precio, estado)
       VALUES ($1, 'emp_a', 'barb_a', 'serv_a', $2, $3, '09:00', '09:30', 20000, 'CONFIRMADA')`,
      [CITA, CLIENTE, FECHA],
    );
    tokenAdmin = await iniciarSesion(ctx, 'admin.a', '1234');
    tokenEmpleado = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    tokenCuentaAdmin = (await iniciarSesionCuenta(ctx, 'cuenta.b@negocio.co', 'Clave-cuenta-1!')).json.token;

    // Una reserva de invitado con ese teléfono deja al empleado una notificación de la cita
    const reserva = await pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      body: reservaValida({ fecha: FECHA, hora: '04:00 PM', telefono: DIGITOS, nombre: 'Cliente Privado' }),
    });
    assert.equal(reserva.estado, 201, reserva.texto);
    await esperarHasta(async () => (await ctx.pool.query("SELECT 1 FROM notificaciones WHERE barbero_id = 'barb_a'")).rowCount);
  });
  after(() => ctx.cerrar());

  const opcion = async (valor: boolean) => {
    const r = await pedir(ctx, RUTA, { method: 'PUT', token: tokenAdmin, body: { empleadosVenTelefono: valor } });
    assert.equal(r.estado, 200, r.texto);
  };

  // Una respuesta "filtra" si trae los dígitos del teléfono (en cualquier formato) o un enlace de WhatsApp del cliente
  const filtra = (texto: string) => texto.replace(/\D/g, '').includes(DIGITOS) || /wa\.me\/57?315/.test(texto);

  // Todas las rutas GET que puede pedir un empleado, y las de administrador con datos de clientes (deben seguir cerradas)
  const RUTAS_GET = [
    '/api/v1/citas/agenda',
    '/api/v1/empresas/actual',
    '/api/v1/funciones',
    `/api/v1/cartera?desde=${fechaEnDias(-30)}&hasta=${fechaEnDias(0)}`,
    '/api/v1/cartera/resumen?periodo=mes',
    '/api/v1/notificaciones',
    '/api/v1/notificaciones/no-leidas',
    '/api/v1/legal/estado',
    `/api/v1/citas/panel/disponibilidad?servicioId=serv_a&fecha=${FECHA}`,
    '/api/v1/clientes',
    `/api/v1/clientes?q=${DIGITOS}`,
    '/api/v1/clientes?q=privado',
    `/api/v1/clientes/${CLIENTE}/historial`,
    '/api/v1/clientes/lista-negra',
    `/api/v1/bloqueos/calendario?desde=${fechaEnDias(0)}&hasta=${fechaEnDias(7)}`,
    '/api/v1/reportes/mejores-clientes?periodo=mes',
    '/api/v1/admin/empresa',
    RUTA,
  ];

  // Cita desde el panel para barb_a: con el cliente existente (por su id) o con el teléfono escrito
  const citaDelPanel = (token: string, cambios: Record<string, unknown> = { clienteId: CLIENTE }) => {
    const hora = horasLibres.shift();
    assert.ok(hora, 'quedan horas libres para la prueba');
    return pedir(ctx, '/api/v1/citas/panel', {
      method: 'POST',
      token,
      body: { barberoId: 'barb_a', servicioId: 'serv_a', fecha: FECHA, hora, autorizacion_registrada_por_negocio: true, ...cambios },
    });
  };

  // Barrido completo como empleado: devuelve las respuestas que traen el teléfono
  const barrer = async () => {
    const conTelefono: string[] = [];
    for (const ruta of RUTAS_GET) {
      const r = await pedir(ctx, ruta, { token: tokenEmpleado });
      assert.ok(r.estado < 500, `GET ${ruta}: ${r.estado} ${r.texto}`);
      if (filtra(r.texto)) conTelefono.push(`GET ${ruta}`);
    }
    const escrituras: [string, Awaited<ReturnType<typeof pedir>>][] = [
      ['POST /citas/panel (clienteId)', await citaDelPanel(tokenEmpleado)],
      ['POST /citas/panel (teléfono)', await citaDelPanel(tokenEmpleado, { nombre: 'Cliente Privado', telefono: DIGITOS })],
      ['PATCH /citas/:id/completar', await pedir(ctx, `/api/v1/citas/${CITA}/completar`, { method: 'PATCH', token: tokenEmpleado })],
    ];
    for (const [nombre, r] of escrituras) {
      assert.ok(r.estado < 500, `${nombre}: ${r.estado} ${r.texto}`);
      if (filtra(r.texto)) conTelefono.push(nombre);
    }
    return conTelefono;
  };

  const telefonoEnAgenda = async (token: string) => {
    const r = await pedir(ctx, '/api/v1/citas/agenda', { token });
    assert.equal(r.estado, 200, r.texto);
    const cita = r.json.find((c: { id: string }) => c.id === CITA);
    assert.ok(cita, 'la cita del cliente está en la agenda');
    assert.ok('telefono' in cita, 'el campo telefono sigue en la respuesta');
    return cita.telefono;
  };

  test('apagada (por defecto): ninguna respuesta al empleado trae el teléfono ni el WhatsApp', async () => {
    assert.deepEqual((await pedir(ctx, RUTA, { token: tokenAdmin })).json, { empleadosVenTelefono: false });
    assert.equal(await telefonoEnAgenda(tokenEmpleado), null);
    const panel = await citaDelPanel(tokenEmpleado);
    assert.equal(panel.estado, 201, panel.texto);
    assert.equal(panel.json.cita.telefono, null);
    assert.equal(panel.json.cita.indicativo, null);
    assert.deepEqual(await barrer(), []);
  });

  test('los administradores siempre lo ven, aunque esté apagada', async () => {
    assert.equal(await telefonoEnAgenda(tokenAdmin), TELEFONO);
    assert.equal(await telefonoEnAgenda(tokenCuentaAdmin), TELEFONO);
    for (const token of [tokenAdmin, tokenCuentaAdmin]) {
      const panel = await citaDelPanel(token);
      assert.equal(panel.estado, 201, panel.texto);
      assert.equal(panel.json.cita.telefono, TELEFONO);
      assert.equal(panel.json.cita.indicativo, '57');
    }
    const clientes = await pedir(ctx, `/api/v1/clientes?q=${DIGITOS}`, { token: tokenAdmin });
    assert.equal(clientes.json.datos[0].telefono, TELEFONO);
  });

  test('de apagada a encendida y de vuelta: el empleado lo nota en la siguiente solicitud, con el mismo token', async () => {
    assert.equal(await telefonoEnAgenda(tokenEmpleado), null);

    await opcion(true);
    assert.equal(await telefonoEnAgenda(tokenEmpleado), TELEFONO);
    const encendida = await citaDelPanel(tokenEmpleado);
    assert.equal(encendida.estado, 201, encendida.texto);
    assert.equal(encendida.json.cita.telefono, TELEFONO);
    assert.equal(encendida.json.cita.indicativo, '57');
    // Control del barrido: encendida, sí detecta el teléfono (no pasa vacío por estar mal armado)
    assert.ok((await barrer()).includes('GET /api/v1/citas/agenda'));

    await opcion(false);
    assert.equal(await telefonoEnAgenda(tokenEmpleado), null);
    assert.deepEqual(await barrer(), []);

    // Otra vuelta completa, sin esperar ni reiniciar
    await opcion(true);
    assert.equal(await telefonoEnAgenda(tokenEmpleado), TELEFONO);
    await opcion(false);
    assert.equal(await telefonoEnAgenda(tokenEmpleado), null);
  });

  test('un empleado que pasa a administrador lo ve de inmediato, y al volver a empleado deja de verlo', async () => {
    await ctx.pool.query("UPDATE barberos SET es_admin = true WHERE id = 'barb_a'");
    assert.equal(await telefonoEnAgenda(tokenEmpleado), TELEFONO);
    await ctx.pool.query("UPDATE barberos SET es_admin = false WHERE id = 'barb_a'");
    assert.equal(await telefonoEnAgenda(tokenEmpleado), null);
  });

  test('si la opción no se puede leer: la cita del panel se guarda, responde 201 con el teléfono en null (nunca 500)', async () => {
    await opcion(true); // aunque estuviera encendida, sin poder leerla no se muestra
    // Simula una falla al leer la opción: la columna deja de existir mientras dura la prueba
    await ctx.pool.query('ALTER TABLE empresas RENAME COLUMN empleados_ven_telefono TO empleados_ven_telefono_x');
    try {
      const panel = await citaDelPanel(tokenEmpleado);
      assert.equal(panel.estado, 201, panel.texto);
      assert.equal(panel.json.cita.telefono, null);
      assert.equal(panel.json.cita.indicativo, null);
      assert.ok(!filtra(panel.texto));
      const guardada = await ctx.pool.query('SELECT estado FROM citas WHERE id = $1', [panel.json.cita.id]);
      assert.equal(guardada.rows[0]?.estado, 'CONFIRMADA');
      assert.equal(await telefonoEnAgenda(tokenEmpleado), null);
      // Los administradores no dependen de la opción: lo siguen viendo
      assert.equal(await telefonoEnAgenda(tokenAdmin), TELEFONO);
    } finally {
      await ctx.pool.query('ALTER TABLE empresas RENAME COLUMN empleados_ven_telefono_x TO empleados_ven_telefono');
      await opcion(false);
    }
  });

  test('la opción encendida en otro negocio no le da permiso al empleado', async () => {
    const tokenAdminB = await iniciarSesion(ctx, 'admin.b', 'clave-b');
    const r = await pedir(ctx, RUTA, { method: 'PUT', token: tokenAdminB, body: { empleadosVenTelefono: true } });
    assert.equal(r.estado, 200, r.texto);
    assert.equal(await telefonoEnAgenda(tokenEmpleado), null);
    assert.deepEqual(await barrer(), []);
  });
});
