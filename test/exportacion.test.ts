import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import ExcelJS from 'exceljs';
import { type Contexto, iniciar, iniciarSesion, pedir } from './apoyo/servidor.js';

// B-9 — la exportación a Excel usa exceljs, que a su vez usa uuid (aviso de npm audit, resuelto con "overrides").
// Esta prueba comprueba que el archivo se genera y se puede leer con la versión de uuid fijada.
describe('exportación de reportes', () => {
  let ctx: Contexto;
  let token: string;
  before(async () => {
    ctx = await iniciar();
    await ctx.pool.query("UPDATE empresas SET plan_equipo = 'pro' WHERE id = 'emp_a'");
    token = await iniciarSesion(ctx, 'admin.a', '1234');
  });
  after(() => ctx.cerrar());

  const descargar = async (formato: string) => {
    const r = await fetch(`${ctx.url}/api/v1/reportes/exportar?periodo=mes&formato=${formato}`, { headers: { Authorization: `Bearer ${token}` } });
    return { estado: r.status, tipo: r.headers.get('content-type') ?? '', cuerpo: Buffer.from(await r.arrayBuffer()) };
  };

  test('el Excel se genera y se puede abrir', async () => {
    const { estado, tipo, cuerpo } = await descargar('xlsx');
    assert.equal(estado, 200);
    assert.match(tipo, /spreadsheetml/);
    assert.equal(cuerpo.subarray(0, 2).toString(), 'PK', 'un .xlsx es un zip');
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(cuerpo as unknown as ArrayBuffer);
    assert.ok(libro.worksheets.length > 0, 'trae hojas');
  });

  test('el PDF se genera', async () => {
    const { estado, tipo, cuerpo } = await descargar('pdf');
    assert.equal(estado, 200);
    assert.match(tipo, /pdf/);
    assert.equal(cuerpo.subarray(0, 4).toString(), '%PDF');
  });

  test('sin formato válido responde 400', async () => {
    const r = await pedir(ctx, '/api/v1/reportes/exportar?periodo=mes&formato=doc', { token });
    assert.equal(r.estado, 400);
  });
});
