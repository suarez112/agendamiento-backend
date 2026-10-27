import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  buscarPlan,
  COBRO,
  comisionPasarela,
  planParaPersonas,
  precioAnualDe,
  precioMensualPara,
  precioPara,
  precioPuesto,
} from '../src/config/planes.js';
import { type Contexto, crearSuperadmin, iniciar, pedir, registrarEmpresa } from './apoyo/servidor.js';

const MAXIMO_PROFESIONALES = `Un negocio puede tener hasta 10 profesionales que atienden clientes. Para agregar a alguien más, quita primero a quien ya no trabaje en el negocio.`;
const MAXIMO_ADMINS = 'Solo puedes tener hasta 2 administradores que no atienden clientes.';

// Precios y niveles (funciones puras)
describe('precios por profesional y niveles', () => {
  test('el primer profesional cuesta $35.000 y cada adicional $25.000; un negocio paga como mínimo uno', () => {
    assert.equal(precioMensualPara(0), 35000);
    assert.equal(precioMensualPara(1), 35000);
    assert.equal(precioMensualPara(2), 60000);
    assert.equal(precioMensualPara(5), 35000 + 4 * 25000);
    assert.equal(precioMensualPara(10), 35000 + 9 * 25000);
    assert.equal(precioPuesto(1, 'mensual'), COBRO.precioPrimerProfesional);
    assert.equal(precioPuesto(7, 'mensual'), COBRO.precioProfesionalAdicional);
  });

  test('el precio anual es el mensual por 12 con 10 % de descuento', () => {
    assert.equal(precioAnualDe(35000), 378000);
    assert.equal(precioPara(1, 'anual'), 378000);
    assert.equal(precioPara(2, 'anual'), 648000);
    assert.equal(precioPuesto(2, 'anual'), 270000);
    for (let n = 1; n <= 10; n++) assert.equal(precioPara(n, 'anual'), Math.round(precioMensualPara(n) * 12 * 0.9));
  });

  test('los niveles salen solos: 1 Emprendedor, 2 a 5 Equipo, 6 a 10 Pro', () => {
    const esperado: [number, string][] = [[0, 'emprendedor'], [1, 'emprendedor'], [2, 'equipo'], [5, 'equipo'], [6, 'pro'], [10, 'pro'], [11, 'pro']];
    for (const [personas, nivel] of esperado) assert.equal(planParaPersonas(personas).id, nivel, `${personas} profesionales`);
    assert.deepEqual([buscarPlan('equipo')?.cupo, buscarPlan('pro')?.cupo, buscarPlan('basico')], [5, 10, undefined]);
  });

  test('la comisión de la pasarela es 2,65 % + $700 por transacción más 19 % de IVA sobre esa comisión', () => {
    assert.equal(comisionPasarela(100000), Math.round((100000 * 0.0265 + 700) * 1.19));
    assert.equal(comisionPasarela(100000, 2), Math.round((100000 * 0.0265 + 1400) * 1.19));
  });
});

describe('niveles, funciones y cargos proporcionales (API)', () => {
  let ctx: Contexto;
  let tokenSuperadmin: string;
  let contador = 0;

  before(async () => {
    ctx = await iniciar();
    tokenSuperadmin = await crearSuperadmin(ctx);
  });
  after(() => ctx.cerrar());

  type Negocio = { token: string; id: string; codigo: string };
  const registrar = async (cambios: Record<string, unknown> = {}): Promise<Negocio> => {
    const n = ++contador;
    const r = await registrarEmpresa(ctx, { correo: `negocio${n}@central.co`, numeroEmpleados: 1, ...cambios });
    assert.equal(r.estado, 201, r.texto);
    return { token: r.json.token, id: r.json.empresa.id, codigo: r.json.empresa.codigoAcceso };
  };

  const agregar = (negocio: Negocio, cambios: Record<string, unknown> = {}) =>
    pedir(ctx, '/api/v1/equipo', {
      method: 'POST',
      token: negocio.token,
      body: { nombre: `Profesional ${++contador}`, usuario: `pro.${contador}.x`, clave: 'Clave-segura-1', ...cambios },
    });
  const agregarVarios = async (negocio: Negocio, cuantos: number) => {
    const ids: string[] = [];
    for (let i = 0; i < cuantos; i++) {
      const r = await agregar(negocio);
      assert.equal(r.estado, 201, r.texto);
      ids.push(r.json.id);
    }
    return ids;
  };
  const funciones = async (negocio: Negocio) => (await pedir(ctx, '/api/v1/funciones', { token: negocio.token })).json;
  const cargos = async (negocio: Negocio) =>
    (await ctx.pool.query('SELECT * FROM cargos WHERE empresa_id = $1 ORDER BY id', [negocio.id])).rows;
  const nivelEnBase = async (negocio: Negocio) =>
    (await ctx.pool.query('SELECT plan_equipo, profesionales_pagados FROM empresas WHERE id = $1', [negocio.id])).rows[0];

  // Deja el negocio con un plan pagado que termina dentro de `dias` días, con `pagados` profesionales cubiertos
  const pagarPlan = (negocio: Negocio, periodo: 'mensual' | 'anual', dias: number, pagados: number) =>
    ctx.pool.query(
      `UPDATE empresas
       SET estado_suscripcion = 'activa', plan_suscripcion = $2, profesionales_pagados = $4, trial_ends_at = NULL,
           suscripcion_fin = (now() AT TIME ZONE zona_horaria)::date + $3::int,
           fecha_pago = (now() AT TIME ZONE zona_horaria)::date
       WHERE id = $1`,
      [negocio.id, periodo, dias, pagados],
    );
  const diasDelPeriodo = async (negocio: Negocio) =>
    (
      await ctx.pool.query(
        `SELECT (suscripcion_fin - (suscripcion_fin - CASE plan_suscripcion WHEN 'anual' THEN interval '1 year' ELSE interval '1 month' END)::date)::int AS d
         FROM empresas WHERE id = $1`,
        [negocio.id],
      )
    ).rows[0].d as number;

  test('el nivel cambia solo al agregar o quitar profesionales que atienden clientes', async () => {
    const negocio = await registrar();
    assert.equal((await funciones(negocio)).nivel.id, 'emprendedor');
    const ids: string[] = [];
    const esperado: Record<number, string> = { 1: 'emprendedor', 2: 'equipo', 5: 'equipo', 6: 'pro', 10: 'pro' };
    for (let n = 1; n <= 10; n++) {
      ids.push(...(await agregarVarios(negocio, 1)));
      const f = await funciones(negocio);
      assert.equal(f.profesionales.cobrados, n);
      if (esperado[n]) {
        assert.equal(f.nivel.id, esperado[n], `${n} profesionales`);
        assert.equal(f.plan.id, esperado[n]);
        assert.equal((await nivelEnBase(negocio)).plan_equipo, esperado[n]);
      }
      assert.equal(f.precio.mensual, precioMensualPara(n));
    }
    // El 11.º no cabe
    const onceavo = await agregar(negocio);
    assert.equal(onceavo.estado, 409);
    assert.deepEqual(onceavo.json, { error: MAXIMO_PROFESIONALES });
    assert.equal((await funciones(negocio)).precio.siguienteProfesionalMensual, null);
    // Quitar a alguien baja el nivel (sin devolver dinero)
    for (const id of ids.slice(0, 5)) assert.equal((await pedir(ctx, `/api/v1/equipo/${id}`, { method: 'DELETE', token: negocio.token })).estado, 200);
    const f = await funciones(negocio);
    assert.deepEqual([f.profesionales.cobrados, f.nivel.id], [5, 'equipo']);
    assert.equal(f.precio.siguienteProfesionalMensual, 25000);
  });

  test('durante la prueba cuenta el número de empleados del registro si es mayor', async () => {
    const grande = await registrar({ numeroEmpleados: 6 });
    assert.equal((await funciones(grande)).nivel.id, 'pro', 'sin profesionales todavía, pero dijo que serán 6');
    const mediano = await registrar({ numeroEmpleados: 3 });
    assert.equal((await funciones(mediano)).nivel.id, 'equipo');
    await pagarPlan(mediano, 'mensual', 20, 1);
    // Con el plan ya pagado solo cuentan los profesionales reales
    await agregarVarios(mediano, 1);
    assert.equal((await funciones(mediano)).nivel.id, 'emprendedor');
  });

  test('cada función solo está en su nivel y responde 403 con el nivel que la incluye', async () => {
    const negocio = await registrar();
    const filtro = 'periodo=mes';
    const ocupacion = () => pedir(ctx, `/api/v1/reportes/ocupacion?${filtro}`, { token: negocio.token });
    const rentables = () => pedir(ctx, `/api/v1/reportes/servicios-rentables?${filtro}`, { token: negocio.token });
    const mejores = () => pedir(ctx, `/api/v1/reportes/mejores-clientes?${filtro}`, { token: negocio.token });

    // Emprendedor: ni ocupación, ni servicios rentables, ni reportes avanzados, ni roles
    const sinOcupacion = await ocupacion();
    assert.equal(sinOcupacion.estado, 403);
    assert.equal(sinOcupacion.json.codigo, 'funcion_no_incluida');
    assert.equal(sinOcupacion.json.funcion, 'ocupacion_profesional');
    assert.deepEqual(sinOcupacion.json.planRequerido, { id: 'equipo', nombre: 'Equipo' });
    assert.equal((await rentables()).json.planRequerido.id, 'pro');
    assert.equal((await mejores()).json.funcion, 'reportes_avanzados');
    const rol = await agregar(negocio, { rol: 'admin' });
    assert.equal(rol.estado, 403);
    assert.equal(rol.json.funcion, 'roles');
    const comision = await agregar(negocio, { porcentajeGanancia: 40 });
    assert.equal(comision.json.funcion, 'comisiones');
    const incluidas = (await funciones(negocio)).funciones.filter((f: { incluida: boolean }) => f.incluida).map((f: { id: string }) => f.id);
    assert.ok(!incluidas.includes('roles') && !incluidas.includes('ocupacion_profesional'));

    // Equipo (2 a 5): ocupación y roles sí; servicios rentables todavía no
    await agregarVarios(negocio, 2);
    assert.equal((await funciones(negocio)).nivel.id, 'equipo');
    assert.equal((await ocupacion()).estado, 200);
    assert.equal((await rentables()).estado, 403);
    assert.equal((await mejores()).estado, 403);
    const conRol = await agregar(negocio, { rol: 'admin', atiendeClientes: false });
    assert.equal(conRol.estado, 201, conRol.texto);

    // Pro (6 a 10): todo
    await agregarVarios(negocio, 4);
    assert.equal((await funciones(negocio)).nivel.id, 'pro');
    for (const consulta of [ocupacion, rentables, mejores]) assert.equal((await consulta()).estado, 200);
    const todas = (await funciones(negocio)).funciones;
    assert.ok(todas.every((f: { incluida: boolean }) => f.incluida));
  });

  test('en la prueba agregar profesionales no genera cargos; con el plan vencido ni siquiera se puede agregar', async () => {
    const enPrueba = await registrar();
    await agregarVarios(enPrueba, 3);
    assert.deepEqual(await cargos(enPrueba), []);

    const vencido = await registrar();
    await agregarVarios(vencido, 1);
    await pagarPlan(vencido, 'mensual', 0, 1);
    const r = await agregar(vencido);
    assert.equal(r.estado, 402, 'el plan terminó hoy: se bloquea la gestión del equipo');
    assert.deepEqual(await cargos(vencido), [], 'y no hay periodo que prorratear');
    assert.equal((await funciones(vencido)).profesionales.cobrados, 1);
  });

  test('al agregar un profesional con el plan mensual pagado se crea un cargo proporcional a los días que faltan', async () => {
    const negocio = await registrar();
    await agregarVarios(negocio, 1);
    await pagarPlan(negocio, 'mensual', 15, 1);
    const [nuevo] = await agregarVarios(negocio, 1);

    const dias = await diasDelPeriodo(negocio);
    const esperado = Math.max(COBRO.cargoProporcionalMinimo, Math.round((precioPuesto(2, 'mensual') * 15) / dias));
    const [cargo, ...resto] = await cargos(negocio);
    assert.equal(resto.length, 0);
    assert.equal(Number(cargo.monto), esperado);
    assert.deepEqual(
      {
        tipo: cargo.tipo,
        estado: cargo.estado,
        periodo: cargo.periodo,
        moneda: cargo.moneda,
        dias_restantes: cargo.dias_restantes,
        dias_periodo: cargo.dias_periodo,
        barbero_id: cargo.barbero_id,
        empresa_codigo: cargo.empresa_codigo,
        pagado_en: cargo.pagado_en,
      },
      {
        tipo: 'profesional_adicional',
        estado: 'pendiente',
        periodo: 'mensual',
        moneda: 'COP',
        dias_restantes: 15,
        dias_periodo: dias,
        barbero_id: nuevo,
        empresa_codigo: negocio.codigo,
        pagado_en: null,
      },
    );
    assert.equal(cargo.concepto, `Profesional 2 del plan mensual: 15 de ${dias} días`);
    assert.equal((await nivelEnBase(negocio)).profesionales_pagados, 2, 'lo pagado ahora cubre a los dos');
  });

  test('el cargo nunca baja del mínimo de $10.000 y el plan anual se prorratea por 365 días', async () => {
    const mensual = await registrar();
    await agregarVarios(mensual, 1);
    await pagarPlan(mensual, 'mensual', 1, 1);
    await agregarVarios(mensual, 1);
    assert.equal(Number((await cargos(mensual))[0].monto), COBRO.cargoProporcionalMinimo, 'queda un día: se cobra el mínimo');

    const anual = await registrar();
    await agregarVarios(anual, 1);
    await pagarPlan(anual, 'anual', 100, 1);
    await agregarVarios(anual, 2);
    const dias = await diasDelPeriodo(anual);
    assert.ok([365, 366].includes(dias));
    const filas = await cargos(anual);
    assert.equal(filas.length, 2, 'un cargo por cada profesional de más');
    assert.deepEqual(
      filas.map((c) => Number(c.monto)),
      [2, 3].map((k) => Math.max(COBRO.cargoProporcionalMinimo, Math.round((precioPuesto(k, 'anual') * 100) / dias))),
    );
    assert.deepEqual(filas.map((c) => c.concepto), [`Profesional 2 del plan anual: 100 de ${dias} días`, `Profesional 3 del plan anual: 100 de ${dias} días`]);
    assert.equal((await nivelEnBase(anual)).profesionales_pagados, 3);
  });

  test('reemplazar a alguien sin pasar de lo ya pagado no cuesta, y quitar a alguien no devuelve dinero', async () => {
    const negocio = await registrar();
    const ids = await agregarVarios(negocio, 2);
    await pagarPlan(negocio, 'mensual', 15, 2);
    assert.equal((await pedir(ctx, `/api/v1/equipo/${ids[1]}`, { method: 'DELETE', token: negocio.token })).estado, 200);
    assert.deepEqual(await cargos(negocio), [], 'quitar no genera cargos ni reembolsos');
    assert.equal((await nivelEnBase(negocio)).profesionales_pagados, 2, 'lo pagado no baja');
    await agregarVarios(negocio, 1);
    assert.deepEqual(await cargos(negocio), [], 'el reemplazo cabe en lo ya pagado');
    await agregarVarios(negocio, 1);
    assert.equal((await cargos(negocio)).length, 1, 'el siguiente sí supera lo pagado');
  });

  test('un administrador que no atiende no se cobra (hasta 2) y un empleado debe atender', async () => {
    const negocio = await registrar();
    await agregarVarios(negocio, 2);
    await pagarPlan(negocio, 'mensual', 15, 2);
    for (let i = 0; i < 2; i++) {
      const r = await agregar(negocio, { rol: 'admin', atiendeClientes: false });
      assert.equal(r.estado, 201, r.texto);
    }
    assert.deepEqual(await cargos(negocio), [], 'los administradores que no atienden no generan cargos');
    const f = await funciones(negocio);
    assert.deepEqual([f.profesionales.cobrados, f.profesionales.adminsSinAtender], [2, 2]);
    assert.equal(f.precio.mensual, precioMensualPara(2));

    const tercero = await agregar(negocio, { rol: 'admin', atiendeClientes: false });
    assert.equal(tercero.estado, 409);
    assert.deepEqual(tercero.json, { error: MAXIMO_ADMINS });
    const empleado = await agregar(negocio, { rol: 'empleado', atiendeClientes: false });
    assert.equal(empleado.estado, 400);
    assert.deepEqual(empleado.json, { error: 'Solo un administrador puede no atender clientes. Un empleado debe atender clientes.' });
  });

  test('"Yo también atiendo clientes" suma un profesional cobrado y al dejar de atender deja de cobrarse', async () => {
    const negocio = await registrar();
    await agregarVarios(negocio, 1);
    await pagarPlan(negocio, 'mensual', 15, 1);
    const activar = await pedir(ctx, '/api/v1/equipo/yo-atiendo', { method: 'PUT', token: negocio.token, body: { atiende: true } });
    assert.equal(activar.estado, 200, activar.texto);
    const f = await funciones(negocio);
    assert.deepEqual([f.profesionales.cobrados, f.nivel.id], [2, 'equipo']);
    assert.equal((await cargos(negocio)).length, 1, 'la administradora que atiende ocupa un puesto más: cargo proporcional');

    const desactivar = await pedir(ctx, '/api/v1/equipo/yo-atiendo', { method: 'PUT', token: negocio.token, body: { atiende: false } });
    assert.equal(desactivar.estado, 200);
    assert.equal((await funciones(negocio)).profesionales.cobrados, 1);
  });

  test('activar el plan desde el panel deja pagados los cargos pendientes y cobra a los profesionales de ese momento', async () => {
    const negocio = await registrar();
    await agregarVarios(negocio, 1);
    await pagarPlan(negocio, 'mensual', 15, 1);
    await agregarVarios(negocio, 2);
    assert.equal((await cargos(negocio)).filter((c) => c.estado === 'pendiente').length, 2);

    const activar = await pedir(ctx, `/api/v1/superadmin/negocios/${negocio.id}/plan`, {
      method: 'POST',
      token: tokenSuperadmin,
      body: { periodo: 'mensual', motivo: 'Pago recibido' },
    });
    assert.equal(activar.estado, 200, activar.texto);
    assert.deepEqual(
      (await cargos(negocio)).map((c) => [c.estado, c.pagado_por]),
      [['pagado', 'activacion'], ['pagado', 'activacion']],
    );
    const historial = await ctx.pool.query('SELECT plan_equipo, periodo, precio::int AS precio, profesionales, origen FROM activaciones_plan WHERE empresa_id = $1', [negocio.id]);
    assert.deepEqual(historial.rows, [{ plan_equipo: 'equipo', periodo: 'mensual', precio: precioPara(3, 'mensual'), profesionales: 3, origen: 'panel' }]);
    const suscripcion = await pedir(ctx, '/api/v1/admin/empresa/suscripcion', { token: negocio.token });
    assert.equal(suscripcion.json.precioPeriodo, precioPara(3, 'mensual'));
    assert.deepEqual([suscripcion.json.profesionalesCobrados, suscripcion.json.profesionalesPagados], [3, 3]);
  });

  test('pagar durante la prueba no pierde los días gratis: el plan empieza cuando termina la prueba', async () => {
    const negocio = await registrar();
    const { rows } = await ctx.pool.query(
      `SELECT ((trial_ends_at AT TIME ZONE zona_horaria)::date + interval '1 month')::date::text AS fin,
              (trial_ends_at AT TIME ZONE zona_horaria)::date - (now() AT TIME ZONE zona_horaria)::date AS dias
       FROM empresas WHERE id = $1`,
      [negocio.id],
    );
    const activar = await pedir(ctx, `/api/v1/superadmin/negocios/${negocio.id}/plan`, { method: 'POST', token: tokenSuperadmin, body: { periodo: 'mensual' } });
    assert.equal(activar.estado, 200, activar.texto);
    const suscripcion = await pedir(ctx, '/api/v1/admin/empresa/suscripcion', { token: negocio.token });
    assert.equal(suscripcion.json.estado, 'activa');
    assert.equal(suscripcion.json.plan, 'mensual');
    assert.equal(suscripcion.json.fechaFin, rows[0].fin);
    assert.equal(suscripcion.json.diasPruebaSumados, rows[0].dias);
  });
});
