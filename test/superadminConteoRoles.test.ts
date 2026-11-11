import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { type Contexto, crearSuperadmin, iniciar, pedir, registrarEmpresa } from './apoyo/servidor.js';

// Superadmin, tabla de Negocios: administradores, empleados y administradores que no atienden clientes.
// Cuenta a todas las personas activas por rol: integrantes del equipo y la cuenta de administración (la de correo).
describe('superadmin: conteo del equipo por rol', () => {
  let ctx: Contexto;
  let token: string;
  before(async () => {
    ctx = await iniciar();
    token = await crearSuperadmin(ctx);
  });
  after(() => ctx.cerrar());

  const integrante = (id: string, empresaId: string, esAdmin: boolean, atiende: boolean, activo = true) =>
    ctx.pool.query(
      `INSERT INTO barberos (id, empresa_id, nombre, usuario, password_hash, es_admin, atiende_clientes, activo)
       VALUES ($1, $2, $1, $1, 'x', $3, $4, $5)`,
      [id, empresaId, esAdmin, atiende, activo],
    );

  const conteos = async (codigo: string, id: string) => {
    const lista = await pedir(ctx, `/api/v1/superadmin/negocios?buscar=${codigo}`, { token });
    assert.equal(lista.estado, 200, lista.texto);
    const fila = lista.json.datos.find((n: { id: string }) => n.id === id);
    const detalle = await pedir(ctx, `/api/v1/superadmin/negocios/${id}`, { token });
    assert.equal(detalle.estado, 200, detalle.texto);
    return { fila, detalle: detalle.json };
  };

  test('cuenta la cuenta de administración, los integrantes activos por rol y quién no atiende', async () => {
    const r = await registrarEmpresa(ctx, { correo: 'roles@central.co', usuario: 'roles.admin', codigoAcceso: 'ROLES1' });
    assert.equal(r.estado, 201, r.texto);
    const id = r.json.empresa.id as string;

    // Recién registrado: solo la cuenta de administración, que no atiende clientes
    let { fila, detalle } = await conteos('ROLES1', id);
    assert.deepEqual(
      { a: fila.administradores, e: fila.empleados, s: fila.administradoresSinAtender },
      { a: 1, e: 0, s: 1 },
    );

    await integrante('rol_admin_no_atiende', id, true, false);
    await integrante('rol_admin_atiende', id, true, true);
    await integrante('rol_empleado_1', id, false, true);
    await integrante('rol_empleado_2', id, false, true);
    await integrante('rol_empleado_inactivo', id, false, true, false);

    ({ fila, detalle } = await conteos('ROLES1', id));
    assert.deepEqual(
      { a: fila.administradores, e: fila.empleados, s: fila.administradoresSinAtender },
      { a: 3, e: 2, s: 2 },
    );
    // El detalle trae las mismas cifras en "equipo"
    assert.deepEqual(
      { a: detalle.equipo.administradores, e: detalle.equipo.empleados, s: detalle.equipo.administradoresSinAtender },
      { a: 3, e: 2, s: 2 },
    );
    assert.equal(detalle.equipo.activos, 4);

    // "Yo también atiendo clientes": su perfil no cuenta como empleado y la cuenta deja de contar como "no atiende"
    const yo = await pedir(ctx, '/api/v1/equipo/yo-atiendo', { method: 'PUT', token: r.json.token, body: { atiende: true } });
    assert.equal(yo.estado, 200, yo.texto);
    ({ fila, detalle } = await conteos('ROLES1', id));
    assert.deepEqual(
      { a: fila.administradores, e: fila.empleados, s: fila.administradoresSinAtender },
      { a: 3, e: 2, s: 1 },
    );
    assert.deepEqual(
      { a: detalle.equipo.administradores, e: detalle.equipo.empleados, s: detalle.equipo.administradoresSinAtender },
      { a: 3, e: 2, s: 1 },
    );
  });
});
