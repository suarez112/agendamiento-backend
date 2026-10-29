import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { COBRO, precioMensualPara } from '../src/config/planes.js';
import { type Contexto, crearSuperadmin, iniciar, pedir, registrarEmpresa } from './apoyo/servidor.js';

// Estadística de negocios por número de profesionales cobrados
describe('superadmin: negocios por número de profesionales', () => {
  let ctx: Contexto;
  let token: string;
  before(async () => {
    ctx = await iniciar();
    token = await crearSuperadmin(ctx);
  });
  after(() => ctx.cerrar());

  const ingresos = async () => (await pedir(ctx, '/api/v1/superadmin/ingresos', { token })).json;
  const grupo = (json: any, n: number) => json.negociosPorProfesionales.find((g: { profesionales: number }) => g.profesionales === n);

  test('trae un grupo por cada número de 1 a 10 con su nivel, y "negocios por nivel" ya no se repite', async () => {
    const json = await ingresos();
    assert.deepEqual(json.negociosPorProfesionales.map((g: { profesionales: number }) => g.profesionales), Array.from({ length: COBRO.maxProfesionales }, (_, i) => i + 1));
    assert.equal(grupo(json, 1).nivel, 'emprendedor');
    assert.equal(grupo(json, 3).nivel, 'equipo');
    assert.equal(grupo(json, 6).nivel, 'pro');
    assert.equal(json.negociosPorNivel, undefined);

    const total = (await pedir(ctx, '/api/v1/superadmin/resumen', { token })).json.totalNegocios;
    assert.equal(json.negociosPorProfesionales.reduce((s: number, g: { negocios: number }) => s + g.negocios, 0), total);

    // El nivel sigue en las estadísticas de la plataforma, una sola vez
    const est = (await pedir(ctx, '/api/v1/superadmin/estadisticas', { token })).json;
    assert.equal(est.negociosPorPlan.length, 3);
  });

  test('cuenta los negocios de cada grupo y suma lo que deja cada uno (activos, mensual estimado)', async () => {
    const r = await registrarEmpresa(ctx, { correo: 'tres.profesionales@central.co' });
    assert.equal(r.estado, 201, r.texto);
    const id = r.json.empresa.id as string;
    // Recién registrado, sin profesionales que atiendan: cuenta como 1 (el mínimo que se cobra)
    const antes = await ingresos();
    for (const i of [1, 2, 3]) {
      await ctx.pool.query(
        `INSERT INTO barberos (id, empresa_id, nombre, usuario, password_hash, es_admin) VALUES ($1, $2, $3, $4, 'x', false)`,
        [`prof_${i}`, id, `Profesional ${i}`, `prof.${i}`],
      );
    }
    const activar = await pedir(ctx, `/api/v1/superadmin/negocios/${id}/plan`, { method: 'POST', token, body: { periodo: 'mensual' } });
    assert.equal(activar.estado, 200, activar.texto);

    const despues = await ingresos();
    const antesTres = grupo(antes, 3);
    const tres = grupo(despues, 3);
    assert.equal(tres.negocios, antesTres.negocios + 1);
    assert.equal(tres.activos, antesTres.activos + 1);
    assert.equal(tres.ingresoMensual.bruto, antesTres.ingresoMensual.bruto + precioMensualPara(3));
    assert.equal(tres.ingresoMensual.neto, tres.ingresoMensual.bruto - tres.ingresoMensual.comisionPasarela);
    // El negocio salió del grupo de 1 profesional
    assert.equal(grupo(despues, 1).negocios, grupo(antes, 1).negocios - 1);
    assert.equal(grupo(despues, 1).ingresoMensual.bruto, grupo(antes, 1).ingresoMensual.bruto);
  });

  test('exige sesión de superadmin', async () => {
    assert.equal((await pedir(ctx, '/api/v1/superadmin/ingresos')).estado, 401);
  });
});
