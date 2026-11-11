import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fechaEnDias } from './apoyo/baseDePrueba.js';
import {
  CLAVE_CLIENTE,
  type Contexto,
  iniciar,
  iniciarSesion,
  pedir,
  registrarCliente,
  telefonoValido,
} from './apoyo/servidor.js';

const OPCION = '/api/v1/admin/empresa/privacidad-clientes';

// Hora del panel en formato "10:00 AM": la n-ésima franja de 30 minutos desde las 08:00
const franja = (n: number) => {
  const m = 8 * 60 + 30 * n;
  const h = Math.floor(m / 60);
  return `${String(((h + 11) % 12) + 1).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

// Cita desde el panel: el empleado (o quien agenda) escribe el nombre y el teléfono, o elige un cliente por su id
const agendar = (ctx: Contexto, token: string, cambios: Record<string, unknown>) =>
  pedir(ctx, '/api/v1/citas/panel', {
    method: 'POST',
    token,
    body: { barberoId: 'barb_a', servicioId: 'serv_a', autorizacion_registrada_por_negocio: true, ...cambios },
  });

// Migración 037: citas.cliente_nombre guarda el nombre que escribió quien agenda desde el panel. Un empleado ve ese
// nombre (en la respuesta, la agenda y el selector), nunca el guardado de un cliente que era de otro empleado.
describe('nombre del cliente en la cita: el empleado ve lo que escribió', () => {
  let ctx: Contexto;
  let tokenAdmin: string;
  let tokenEmpleado: string;
  const FECHA = fechaEnDias(3);
  const DIGITOS_OTRO = '3154440001'; // cliente guardado de otro empleado (barb_a2)
  const DIGITOS_VIEJO = '3154440002'; // cliente de barb_a con una cita anterior a la migración (sin nombre escrito)
  let siguiente = 0;
  const hora = () => franja(siguiente++);

  before(async () => {
    ctx = await iniciar();
    tokenAdmin = await iniciarSesion(ctx, 'admin.a', '1234');
    tokenEmpleado = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    await ctx.pool.query(
      `INSERT INTO clientes (id, empresa_id, telefono, indicativo, nombre, total_citas, fecha_ultima_cita) VALUES
         ('cli_otro', 'emp_a', $1, '57', 'Nombre Guardado', 1, $3),
         ('cli_viejo', 'emp_a', $2, '57', 'Cliente Viejo', 1, $3)`,
      [`+57${DIGITOS_OTRO}`, `+57${DIGITOS_VIEJO}`, FECHA],
    );
    await ctx.pool.query(
      `INSERT INTO citas (id, empresa_id, barbero_id, servicio_id, cliente_id, fecha, hora_inicio, hora_fin, precio, estado) VALUES
         ('cita_otro', 'emp_a', 'barb_a2', 'serv_a', 'cli_otro', $1, '08:00', '08:30', 20000, 'CONFIRMADA'),
         ('cita_vieja', 'emp_a', 'barb_a', 'serv_a', 'cli_viejo', $1, '19:00', '19:30', 20000, 'CONFIRMADA')`,
      [FECHA],
    );
  });
  after(() => ctx.cerrar());

  const opcion = async (valor: boolean) => {
    const r = await pedir(ctx, OPCION, { method: 'PUT', token: tokenAdmin, body: { empleadosVenTelefono: valor } });
    assert.equal(r.estado, 200, r.texto);
  };
  const enAgenda = async (token: string, id: string) => {
    const r = await pedir(ctx, '/api/v1/citas/agenda', { token });
    assert.equal(r.estado, 200, r.texto);
    return r.json.find((c: { id: string }) => c.id === id);
  };
  const sinIdNiHora = ({ id: _id, hora: _hora, ...resto }: Record<string, unknown>) => resto;

  test('la respuesta es idéntica con un teléfono nuevo y con el de un cliente de otro empleado (y muestra lo escrito)', async () => {
    const nuevo = await agendar(ctx, tokenEmpleado, { fecha: FECHA, hora: hora(), nombre: 'Escrito Por Empleado', telefono: telefonoValido(7101) });
    const existente = await agendar(ctx, tokenEmpleado, { fecha: FECHA, hora: hora(), nombre: 'Escrito Por Empleado', telefono: DIGITOS_OTRO });
    assert.equal(nuevo.estado, 201, nuevo.texto);
    assert.equal(existente.estado, 201, existente.texto);
    assert.deepEqual(Object.keys(nuevo.json).sort(), Object.keys(existente.json).sort());
    assert.deepEqual(sinIdNiHora(nuevo.json.cita), sinIdNiHora(existente.json.cita));
    assert.equal(existente.json.mensaje, nuevo.json.mensaje);
    assert.equal(existente.json.cita.cliente, 'Escrito Por Empleado');
    assert.ok(!existente.texto.includes('Nombre Guardado'));

    // Se reutiliza el mismo cliente: su nombre guardado no cambia; la cita guarda lo escrito
    const guardado = await ctx.pool.query("SELECT nombre, total_citas FROM clientes WHERE id = 'cli_otro'");
    assert.deepEqual(guardado.rows[0], { nombre: 'Nombre Guardado', total_citas: 2 });
    const cita = await ctx.pool.query('SELECT cliente_id, cliente_nombre FROM citas WHERE id = $1', [existente.json.cita.id]);
    assert.deepEqual(cita.rows[0], { cliente_id: 'cli_otro', cliente_nombre: 'Escrito Por Empleado' });
  });

  test('con la opción de teléfonos encendida, la respuesta trae el teléfono escrito, exista o no el cliente', async () => {
    await opcion(true);
    try {
      const nuevo = await agendar(ctx, tokenEmpleado, { fecha: FECHA, hora: hora(), nombre: 'Otro Escrito', telefono: telefonoValido(7102) });
      const existente = await agendar(ctx, tokenEmpleado, { fecha: FECHA, hora: hora(), nombre: 'Otro Escrito', telefono: DIGITOS_OTRO });
      assert.equal(nuevo.json.cita.telefono, `+57${telefonoValido(7102)}`);
      assert.equal(existente.json.cita.telefono, `+57${DIGITOS_OTRO}`);
      const { telefono: _a, ...restoNuevo } = sinIdNiHora(nuevo.json.cita);
      const { telefono: _b, ...restoExistente } = sinIdNiHora(existente.json.cita);
      assert.deepEqual(restoNuevo, restoExistente);
    } finally {
      await opcion(false);
    }
  });

  test('la agenda y el selector del empleado muestran el nombre escrito, y no se puede buscar por el guardado', async () => {
    const r = await agendar(ctx, tokenEmpleado, { fecha: FECHA, hora: hora(), nombre: 'Escrito Agenda', telefono: DIGITOS_OTRO });
    assert.equal(r.estado, 201, r.texto);
    assert.equal((await enAgenda(tokenEmpleado, r.json.cita.id)).cliente, 'Escrito Agenda');
    const agenda = await pedir(ctx, '/api/v1/citas/agenda', { token: tokenEmpleado });
    assert.ok(!agenda.texto.includes('Nombre Guardado'));

    // Selector: el cliente aparece con el nombre de su cita más reciente con él, y buscar el nombre guardado no lo revela
    const porEscrito = await pedir(ctx, '/api/v1/clientes/buscar?q=escrito', { token: tokenEmpleado });
    assert.deepEqual(
      porEscrito.json.datos.filter((c: { id: string }) => c.id === 'cli_otro'),
      [{ id: 'cli_otro', nombre: 'Escrito Agenda', telefono: null, indicativo: null }],
    );
    const porGuardado = await pedir(ctx, '/api/v1/clientes/buscar?q=guardado', { token: tokenEmpleado });
    assert.deepEqual(porGuardado.json.datos, []);

    // Al elegirlo en el selector (clienteId), la respuesta usa el nombre que él ve, no el guardado
    const elegido = await agendar(ctx, tokenEmpleado, { fecha: FECHA, hora: hora(), clienteId: 'cli_otro' });
    assert.equal(elegido.estado, 201, elegido.texto);
    assert.equal(elegido.json.cita.cliente, 'Escrito Agenda');
    assert.equal((await enAgenda(tokenEmpleado, elegido.json.cita.id)).cliente, 'Escrito Agenda');
  });

  test('el administrador sigue viendo el nombre guardado del cliente en la agenda y el selector', async () => {
    const r = await agendar(ctx, tokenEmpleado, { fecha: FECHA, hora: hora(), nombre: 'Escrito Para Admin', telefono: DIGITOS_OTRO });
    assert.equal(r.estado, 201, r.texto);
    assert.equal((await enAgenda(tokenAdmin, r.json.cita.id)).cliente, 'Nombre Guardado');
    const selector = await pedir(ctx, '/api/v1/clientes/buscar?q=guardado', { token: tokenAdmin });
    assert.deepEqual(selector.json.datos.map((c: { id: string; nombre: string }) => [c.id, c.nombre]), [['cli_otro', 'Nombre Guardado']]);
    // Si el administrador elige un cliente existente, la cita no guarda un nombre escrito (muestra el guardado)
    const elegido = await agendar(ctx, tokenAdmin, { barberoId: 'barb_a2', fecha: FECHA, hora: hora(), clienteId: 'cli_otro' });
    assert.equal(elegido.estado, 201, elegido.texto);
    assert.equal(elegido.json.cita.cliente, 'Nombre Guardado');
    const fila = await ctx.pool.query('SELECT cliente_nombre FROM citas WHERE id = $1', [elegido.json.cita.id]);
    assert.equal(fila.rows[0].cliente_nombre, null);
  });

  test('una cita anterior, sin nombre escrito, sigue mostrando el nombre guardado', async () => {
    assert.equal((await enAgenda(tokenEmpleado, 'cita_vieja')).cliente, 'Cliente Viejo');
    assert.equal((await enAgenda(tokenAdmin, 'cita_vieja')).cliente, 'Cliente Viejo');
    const selector = await pedir(ctx, '/api/v1/clientes/buscar?q=viejo', { token: tokenEmpleado });
    assert.deepEqual(selector.json.datos, [{ id: 'cli_viejo', nombre: 'Cliente Viejo', telefono: null, indicativo: null }]);
    const columna = await ctx.pool.query("SELECT cliente_nombre FROM citas WHERE id = 'cita_vieja'");
    assert.equal(columna.rows[0].cliente_nombre, null);
  });

  test('al eliminar la cuenta del cliente se borra también el nombre escrito en sus citas', async () => {
    const telefono = telefonoValido(7103);
    const cuenta = await registrarCliente(ctx, 'nombre.cita@correo.com', CLAVE_CLIENTE, { telefono, nombre: 'Titular Cuenta' });
    assert.equal(cuenta.estado, 201, cuenta.texto);
    const r = await agendar(ctx, tokenEmpleado, { fecha: FECHA, hora: hora(), nombre: 'Escrito Antes De Borrar', telefono });
    assert.equal(r.estado, 201, r.texto);
    const eliminar = await pedir(ctx, '/api/v1/cuentas/eliminar', { method: 'POST', token: cuenta.json.token, body: { clave: CLAVE_CLIENTE } });
    assert.equal(eliminar.estado, 200, eliminar.texto);
    const fila = await ctx.pool.query('SELECT cliente_nombre FROM citas WHERE id = $1', [r.json.cita.id]);
    assert.equal(fila.rows[0].cliente_nombre, null);
    assert.equal((await enAgenda(tokenEmpleado, r.json.cita.id)).cliente, 'Cliente eliminado');
  });
});

// Tope de citas creadas desde el panel por cada empleado (10 por minuto y 60 por hora en producción). En las pruebas
// se usan topes chicos con las mismas reglas.
describe('límite de citas desde el panel por empleado', () => {
  const MINUTO = 'Agendaste 3 citas en menos de un minuto. Espera un momento antes de agendar otra.';
  const HORA = 'Agendaste 4 citas en la última hora, el máximo para un empleado. Intenta de nuevo más tarde o pídele al administrador que la agende.';

  test('por minuto: al pasarse responde 429 con el mensaje; los errores no cuentan; cada empleado tiene su propio tope', async () => {
    const ctx = await iniciar({ limites: { citasPanelPorMinuto: 3, citasPanelPorHora: 100 } });
    try {
      const empleado = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
      const empleado2 = await iniciarSesion(ctx, 'barbero.a2', 'secreta');
      const fecha = fechaEnDias(4);
      // Intentos que fallan (fuera del horario) no gastan el tope
      for (let i = 0; i < 3; i++) {
        const fallido = await agendar(ctx, empleado, { fecha, hora: '07:00 AM', nombre: 'Error', telefono: telefonoValido(7200) });
        assert.equal(fallido.estado, 400, fallido.texto);
      }
      for (let i = 0; i < 3; i++) {
        const r = await agendar(ctx, empleado, { fecha, hora: franja(i), nombre: `Cliente ${i}`, telefono: telefonoValido(7201 + i) });
        assert.equal(r.estado, 201, r.texto);
      }
      const pasado = await agendar(ctx, empleado, { fecha, hora: franja(3), nombre: 'De más', telefono: telefonoValido(7210) });
      assert.equal(pasado.estado, 429, pasado.texto);
      assert.deepEqual(pasado.json, { error: MINUTO });
      const guardadas = await ctx.pool.query("SELECT count(*)::int AS n FROM citas WHERE barbero_id = 'barb_a' AND fecha = $1", [fecha]);
      assert.equal(guardadas.rows[0].n, 3);
      // Otro empleado no comparte el contador
      const otro = await agendar(ctx, empleado2, { barberoId: 'barb_a2', fecha, hora: franja(0), nombre: 'Del otro', telefono: telefonoValido(7211) });
      assert.equal(otro.estado, 201, otro.texto);
    } finally {
      await ctx.cerrar();
    }
  });

  test('por hora: al pasarse responde 429 con su mensaje; el administrador no tiene este tope', async () => {
    const ctx = await iniciar({ limites: { citasPanelPorMinuto: 100, citasPanelPorHora: 4 } });
    try {
      const empleado = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
      const admin = await iniciarSesion(ctx, 'admin.a', '1234');
      const fecha = fechaEnDias(5);
      for (let i = 0; i < 4; i++) {
        const r = await agendar(ctx, empleado, { fecha, hora: franja(i), nombre: `Cliente ${i}`, telefono: telefonoValido(7301 + i) });
        assert.equal(r.estado, 201, r.texto);
      }
      const pasado = await agendar(ctx, empleado, { fecha, hora: franja(4), nombre: 'De más', telefono: telefonoValido(7310) });
      assert.equal(pasado.estado, 429, pasado.texto);
      assert.deepEqual(pasado.json, { error: HORA });
      for (let i = 0; i < 6; i++) {
        const r = await agendar(ctx, admin, { barberoId: 'barb_a2', fecha, hora: franja(i), nombre: `Admin ${i}`, telefono: telefonoValido(7320 + i) });
        assert.equal(r.estado, 201, r.texto);
      }
    } finally {
      await ctx.cerrar();
    }
  });

  test('los topes de producción son 10 por minuto y 60 por hora', async () => {
    const { LIMITES_POR_DEFECTO } = await import('../src/shared/http/limitadores.js');
    assert.equal(LIMITES_POR_DEFECTO.citasPanelPorMinuto, 10);
    assert.equal(LIMITES_POR_DEFECTO.citasPanelPorHora, 60);
  });
});
