import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { separarDocumentosLegales, sqlPublicarVersion } from '../src/db/documentosLegales.js';
import { CLAVE_CLIENTE, type Contexto, iniciar, iniciarSesionCuenta, pedir, registrarCliente } from './apoyo/servidor.js';

const FUENTE = 'docs/legal/agendality_documentos_legales_v1.1.md';
const md = readFileSync(new URL(`../${FUENTE}`, import.meta.url), 'utf8');
const palabras = (texto: string) => texto.split(/\s+/).filter(Boolean);

describe('documentos legales 1.1 (migraciones 035 y 036)', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  test('el texto separado conserva cada palabra del .md, sin los encabezados "DOCUMENTO N", los separadores ni la línea de versión', () => {
    const docs = separarDocumentosLegales(md, '1.1');
    const lineaVersion = /^\*\*Versión 1\.1 · Vigentes? desde el .+\*\*$/;
    const sinMarcas = md.replace(/^# DOCUMENTO \d+ · /gm, '').split('\n');
    assert.equal(sinMarcas.filter((l) => lineaVersion.test(l)).length, 3, 'los tres documentos tienen su línea de versión');
    const esperado = palabras(sinMarcas.filter((l) => l.trim() !== '---' && !lineaVersion.test(l)).join('\n'));
    assert.deepEqual(palabras(docs.map((d) => `${d.titulo}\n${d.contenido}`).join('\n')), esperado);
    for (const d of docs) assert.doesNotMatch(d.contenido, /Vigentes? desde/, d.tipo);
    assert.deepEqual(
      docs.map((d) => [d.tipo, d.vigenteDesde]),
      [['politica_datos', '2026-11-10'], ['terminos', '2026-11-10'], ['aviso_privacidad', '2026-11-10']],
    );
    for (const d of docs) assert.ok(d.vigenteDesde, `${d.tipo} must have an effective date`);
  });

  test('una línea de versión con otra versión o una fecha inválida detiene el script', () => {
    const doc = (linea: string) => `# DOCUMENTO 1 · A\n\n${linea}\n\nTexto\n\n# DOCUMENTO 2 · B\n\nTexto\n\n# DOCUMENTO 3 · C\n\nTexto\n`;
    assert.throws(() => separarDocumentosLegales(doc('**Versión 1.0 · Vigente desde el 9 de noviembre de 2026**'), '1.1'), /expected 1\.1/);
    assert.throws(() => separarDocumentosLegales(doc('**Versión 1.1 · Vigente desde el 31 de noviembre de 2026**'), '1.1'), /invalid date/);
    assert.throws(() => separarDocumentosLegales(doc('**Versión 1.1 · Vigente desde [FECHA]**'), '1.1'), /unrecognized version line/);
    assert.equal(separarDocumentosLegales(doc('**Versión 1.1 · Vigente desde el 1 de enero de 2027**'), '1.1')[0]!.vigenteDesde, '2027-01-01');
  });

  test('la migración 036 es exactamente lo que genera el script a partir del .md', () => {
    const migracion = readFileSync(new URL('../db/migraciones/036_documentos_legales_v1_1.sql', import.meta.url), 'utf8');
    assert.equal(migracion, sqlPublicarVersion('1.1', separarDocumentosLegales(md, '1.1'), FUENTE));
  });

  test('los endpoints sirven la 1.1 con el texto del .md, su fecha de vigencia, títulos y tablas en markdown', async () => {
    const docs = separarDocumentosLegales(md, '1.1');
    const rutas = { politica_datos: 'politica-datos', terminos: 'terminos', aviso_privacidad: 'aviso-privacidad' };
    for (const d of docs) {
      const r = await pedir(ctx, `/api/v1/legal/${rutas[d.tipo]}`);
      assert.equal(r.estado, 200, r.texto);
      assert.deepEqual([r.json.tipo, r.json.version, r.json.titulo, r.json.vigenteDesde], [d.tipo, '1.1', d.titulo, d.vigenteDesde]);
      assert.equal(r.json.contenido, d.contenido);
    }
    const politica = (await pedir(ctx, '/api/v1/legal/politica-datos')).json.contenido as string;
    assert.match(politica, /^### 1\. Responsable del Tratamiento$/m);
    assert.match(politica, /^\| Titular \| Datos recolectados \| Fuente \/ método de obtención \|$/m);
  });

  test('la 1.0 y la 0.1 se conservan como historial', async () => {
    const { rows } = await ctx.pool.query(
      `SELECT tipo, version, to_char(vigente_desde, 'YYYY-MM-DD') AS vigente_desde FROM documentos_legales ORDER BY tipo, version`,
    );
    assert.deepEqual(rows, [
      { tipo: 'aviso_privacidad', version: '1.0', vigente_desde: null },
      { tipo: 'aviso_privacidad', version: '1.1', vigente_desde: '2026-11-10' },
      { tipo: 'politica_datos', version: '0.1-borrador', vigente_desde: null },
      { tipo: 'politica_datos', version: '1.0', vigente_desde: null },
      { tipo: 'politica_datos', version: '1.1', vigente_desde: '2026-11-10' },
      { tipo: 'terminos', version: '0.1-borrador', vigente_desde: null },
      { tipo: 'terminos', version: '1.0', vigente_desde: null },
      { tipo: 'terminos', version: '1.1', vigente_desde: '2026-11-10' },
    ]);
  });

  test('quien aceptó la 1.0 debe aceptar la 1.1; quien se registra hoy guarda la 1.1', async () => {
    const r = await registrarCliente(ctx, 'v11@correo.com', CLAVE_CLIENTE);
    assert.equal(r.estado, 201, r.texto);
    const token = r.json.token;
    assert.deepEqual(
      (await ctx.pool.query('SELECT version_politica, version_terminos FROM auditoria_autorizaciones WHERE usuario_id = $1', [r.json.usuario.id])).rows,
      [{ version_politica: '1.1', version_terminos: '1.1' }],
    );
    assert.equal((await pedir(ctx, '/api/v1/legal/estado', { token })).json.vigente, true);

    // Otra cuenta cuya única aceptación es de la 1.0
    const antigua = await registrarCliente(ctx, 'v10@correo.com', CLAVE_CLIENTE, { telefono: '3009990010' });
    assert.equal(antigua.estado, 201, antigua.texto);
    await ctx.pool.query(
      `INSERT INTO auditoria_autorizaciones (usuario_id, canal, version_politica, version_terminos, aceptado_en)
       VALUES ($1, 'registro_cliente', '1.0', '1.0', now() + interval '1 second')`,
      [antigua.json.usuario.id],
    );
    const estado = (await pedir(ctx, '/api/v1/legal/estado', { token: antigua.json.token })).json;
    assert.deepEqual([estado.vigente, estado.versionPolitica, estado.versionTerminos], [false, '1.1', '1.1']);
  });

  test('el login avisa a quien solo tiene aceptada la 1.0', async () => {
    const r = await registrarCliente(ctx, 'solo10@correo.com', CLAVE_CLIENTE, { telefono: '3009990011' });
    assert.equal(r.estado, 201, r.texto);
    // Simula una cuenta anterior a la 1.1: su prueba de registro queda como 1.0 (solo inserción: se crea otra cuenta sin prueba)
    const sinPrueba = await ctx.pool.query<{ id: string }>(
      `INSERT INTO usuarios (correo, password_hash, rol, nombre, telefono, indicativo)
       SELECT 'antes@correo.com', password_hash, 'cliente', 'Antes', '+573009990012', '57' FROM usuarios WHERE id = $1
       RETURNING id`,
      [r.json.usuario.id],
    );
    await ctx.pool.query(
      `INSERT INTO auditoria_autorizaciones (usuario_id, canal, version_politica, version_terminos) VALUES ($1, 'registro_cliente', '1.0', '1.0')`,
      [sinPrueba.rows[0]!.id],
    );
    const login = await iniciarSesionCuenta(ctx, 'antes@correo.com', CLAVE_CLIENTE);
    assert.equal(login.estado, 200, login.texto);
    assert.equal(login.json.debeAceptarDocumentos, true);
  });
});
