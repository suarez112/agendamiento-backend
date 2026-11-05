import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fechaEnDias } from './apoyo/baseDePrueba.js';
import { type Contexto, iniciar, iniciarSesion, pedir } from './apoyo/servidor.js';

// GET /clientes: sin parámetros, la lista completa de siempre; con limite, cursor o q, páginas con cursor y búsqueda
describe('paginación y búsqueda de clientes', () => {
  let ctx: Contexto;
  let tokenAdmin: string;
  let tokenEmpleado: string;

  // 25 clientes en el negocio A: fechas repetidas, sin fecha y un nombre repetido con la misma fecha (empate total)
  const TOTAL = 25;
  before(async () => {
    ctx = await iniciar();
    tokenAdmin = await iniciarSesion(ctx, 'admin.a', '1234');
    tokenEmpleado = await iniciarSesion(ctx, 'barbero.a', 'clave-a');
    const valores: string[] = [];
    for (let i = 1; i <= TOTAL; i++) {
      const id = `pag_${String(i).padStart(2, '0')}`;
      const nombre = i === 7 || i === 8 ? 'Nombre Repetido' : `Cliente ${String(i).padStart(2, '0')}`;
      const fecha = i % 5 === 0 ? 'NULL' : `'${fechaEnDias(-(i % 3))}'`;
      valores.push(`('${id}', 'emp_a', '+57311000${String(i).padStart(4, '0')}', '57', '${nombre}', 1, ${fecha})`);
    }
    await ctx.pool.query(`
      INSERT INTO clientes (id, empresa_id, telefono, indicativo, nombre, total_citas, fecha_ultima_cita) VALUES
        ${valores.join(',\n')},
        ('pag_pct', 'emp_a', '+573120000001', '57', 'Ana 100% Real_', 1, NULL);
    `);
  });
  after(() => ctx.cerrar());

  const listar = (consulta = '', token = tokenAdmin) => pedir(ctx, `/api/v1/clientes${consulta}`, { token });

  // Orden esperado: el de la lista de siempre, con el id como desempate
  const idsEnOrden = async () =>
    (
      await ctx.pool.query<{ id: string }>(
        `SELECT id FROM clientes WHERE empresa_id = 'emp_a' ORDER BY fecha_ultima_cita DESC NULLS LAST, nombre, id`,
      )
    ).rows.map((f) => f.id);

  test('sin parámetros responde la lista completa de siempre (un arreglo)', async () => {
    const r = await listar();
    assert.equal(r.estado, 200, r.texto);
    assert.ok(Array.isArray(r.json));
    assert.equal(r.json.length, TOTAL + 1);
    assert.deepEqual(Object.keys(r.json[0]).sort(), [
      'citasCanceladas', 'citasCompletadas', 'enListaNegra', 'estado', 'fechaUltimaCita',
      'id', 'indicativo', 'listaNegraId', 'nombre', 'telefono', 'totalCitas',
    ]);
    assert.deepEqual(new Set(r.json.map((c: { id: string }) => c.id)), new Set(await idsEnOrden()));
  });

  test('por defecto trae 20 por página y el cursor lleva a la siguiente hasta el final', async () => {
    const p1 = await listar('?cursor=');
    assert.equal(p1.estado, 400, 'un cursor vacío no es válido');

    const primera = await listar('?q=');
    assert.equal(primera.estado, 200, primera.texto);
    assert.deepEqual(Object.keys(primera.json).sort(), ['datos', 'siguienteCursor']);
    assert.equal(primera.json.datos.length, 20);
    assert.equal(typeof primera.json.siguienteCursor, 'string');

    const segunda = await listar(`?cursor=${encodeURIComponent(primera.json.siguienteCursor)}`);
    assert.equal(segunda.estado, 200, segunda.texto);
    assert.equal(segunda.json.datos.length, TOTAL + 1 - 20);
    assert.equal(segunda.json.siguienteCursor, null);
  });

  test('recorrer todas las páginas no repite ni salta clientes, aun con fechas y nombres repetidos', async () => {
    const vistos: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const consulta: string = `?limite=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r = await listar(consulta);
      assert.equal(r.estado, 200, r.texto);
      assert.ok(r.json.datos.length <= 3);
      vistos.push(...r.json.datos.map((c: { id: string }) => c.id));
      cursor = r.json.siguienteCursor;
      paginas++;
    } while (cursor && paginas < 50);
    assert.deepEqual(vistos, await idsEnOrden());
  });

  test('busca por nombre sin distinguir mayúsculas y por los dígitos del teléfono', async () => {
    const porNombre = await listar('?q=nombre%20REPETIDO');
    assert.equal(porNombre.estado, 200, porNombre.texto);
    assert.deepEqual(porNombre.json.datos.map((c: { id: string }) => c.id).sort(), ['pag_07', 'pag_08']);

    const porTelefono = await listar(`?q=${encodeURIComponent('311 000-0012')}`);
    assert.equal(porTelefono.estado, 200, porTelefono.texto);
    assert.deepEqual(porTelefono.json.datos.map((c: { id: string }) => c.id), ['pag_12']);

    const conIndicativo = await listar(`?q=${encodeURIComponent('+57 311 000 0012')}`);
    assert.deepEqual(conIndicativo.json.datos.map((c: { id: string }) => c.id), ['pag_12']);

    // Un texto con letras y números busca solo en el nombre (no en los dígitos del teléfono)
    const nombreConNumero = await listar(`?q=${encodeURIComponent('cliente 12')}`);
    assert.deepEqual(nombreConNumero.json.datos.map((c: { id: string }) => c.id), ['pag_12']);

    // Los comodines de SQL se buscan como texto: "%" y "_" no traen a todos
    const comodin = await listar(`?q=${encodeURIComponent('100%')}`);
    assert.deepEqual(comodin.json.datos.map((c: { id: string }) => c.id), ['pag_pct']);
    const guion = await listar(`?q=${encodeURIComponent('_')}`);
    assert.deepEqual(guion.json.datos.map((c: { id: string }) => c.id), ['pag_pct']);

    const nada = await listar('?q=zzzz');
    assert.deepEqual(nada.json, { datos: [], siguienteCursor: null });
  });

  test('la búsqueda pagina con el mismo cursor', async () => {
    const p1 = await listar('?q=cliente&limite=10');
    assert.equal(p1.json.datos.length, 10);
    const p2 = await listar(`?q=cliente&limite=10&cursor=${encodeURIComponent(p1.json.siguienteCursor)}`);
    const p3 = await listar(`?q=cliente&limite=10&cursor=${encodeURIComponent(p2.json.siguienteCursor)}`);
    const todos = [...p1.json.datos, ...p2.json.datos, ...p3.json.datos].map((c: { id: string }) => c.id);
    assert.equal(new Set(todos).size, todos.length);
    assert.equal(todos.length, TOTAL - 2); // todos menos los dos "Nombre Repetido"
    assert.equal(p3.json.siguienteCursor, null);
  });

  test('nunca trae clientes de otro negocio', async () => {
    const r = await listar('?q=Cliente%20de%20B');
    assert.deepEqual(r.json, { datos: [], siguienteCursor: null });
    const tel = await listar('?q=3009998877');
    assert.deepEqual(tel.json, { datos: [], siguienteCursor: null });
  });

  test('valida limite, cursor y q', async () => {
    const MENSAJE_LIMITE = 'El límite debe ser un número entero entre 1 y 50';
    for (const limite of ['51', '0', '-1', '2.5', 'abc', '']) {
      const r = await listar(`?limite=${limite}`);
      assert.equal(r.estado, 400, `limite=${limite}`);
      assert.equal(r.json.error, MENSAJE_LIMITE);
    }
    assert.equal((await listar('?limite=50')).estado, 200);
    const armarCursor = (f: unknown, n = 'a', i = 'b') => Buffer.from(JSON.stringify({ f, n, i })).toString('base64url');
    for (const cursor of [
      'basura',
      'eyJ4IjoxfQ',
      Buffer.from('{"f":"no-fecha","n":"a","i":"b"}').toString('base64url'),
      // Fechas que no existen y caracteres nulos (antes respondían 500)
      armarCursor('2026-02-30'),
      armarCursor('0000-01-01'),
      armarCursor(null, 'a\u0000b'),
      armarCursor('2026-01-10', 'a', 'b\u0000'),
      // El cursor lleva solo el id: uno que no existe, el de un cliente de otro negocio o con un carácter nulo
      Buffer.from('no_existe').toString('base64url'),
      Buffer.from('cli_b').toString('base64url'),
      Buffer.from('pag_01\u0000').toString('base64url'),
      'x'.repeat(101),
    ]) {
      const r = await listar(`?cursor=${cursor}`);
      assert.equal(r.estado, 400, `cursor=${cursor}`);
      assert.equal(r.json.error, 'El cursor no es válido. Vuelve a pedir la primera página.');
    }
    const larga = await listar(`?q=${'a'.repeat(101)}`);
    assert.equal(larga.estado, 400);
    assert.equal(larga.json.error, 'La búsqueda puede tener hasta 100 caracteres');
    const nulo = await listar('?q=a%00b');
    assert.equal(nulo.estado, 400);
    assert.equal(nulo.json.error, 'La búsqueda debe ser un texto');
  });

  test('un cliente con un nombre muy largo y con tildes no rompe la paginación (el cursor no lleva el nombre)', async () => {
    const largo = 'Ñandú José María Álvarez Peñaloza '.repeat(15).trim(); // ~500 caracteres, muchos de 2 bytes
    await ctx.pool.query(
      `INSERT INTO clientes (id, empresa_id, telefono, indicativo, nombre, total_citas, fecha_ultima_cita)
       VALUES ('pag_largo', 'emp_a', '+573129999999', '57', $1, 1, $2), ('pag_tras_largo', 'emp_a', '+573129999998', '57', $3, 1, $2)`,
      [largo, fechaEnDias(-10), `${largo} Z`],
    );
    try {
      const primera = await listar(`?q=${encodeURIComponent('Ñandú')}&limite=1`);
      assert.equal(primera.estado, 200, primera.texto);
      assert.deepEqual(primera.json.datos.map((c: { id: string }) => c.id), ['pag_largo']);
      assert.ok(primera.json.siguienteCursor.length <= 100, 'el cursor mide lo mismo sin importar el nombre');
      const segunda = await listar(`?q=${encodeURIComponent('Ñandú')}&limite=1&cursor=${encodeURIComponent(primera.json.siguienteCursor)}`);
      assert.equal(segunda.estado, 200, segunda.texto);
      assert.deepEqual(segunda.json.datos.map((c: { id: string }) => c.id), ['pag_tras_largo']);
      assert.equal(segunda.json.siguienteCursor, null);
    } finally {
      await ctx.pool.query("DELETE FROM clientes WHERE id IN ('pag_largo', 'pag_tras_largo')");
    }
  });

  test('sigue siendo solo para administradores, también con parámetros', async () => {
    for (const consulta of ['', '?limite=5', '?q=cliente']) {
      const r = await listar(consulta, tokenEmpleado);
      assert.equal(r.estado, 403, consulta);
    }
  });
});
