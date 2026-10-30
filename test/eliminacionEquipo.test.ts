import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { fechaHabilEnDias } from './apoyo/baseDePrueba.js';
import {
  CLAVE_ADMIN,
  CLAVE_CLIENTE,
  type Contexto,
  esperarHasta,
  iniciar,
  iniciarSesion,
  pedir,
  registrarCliente,
  registrarEmpresa,
  reservaValida,
} from './apoyo/servidor.js';

// M-6 — eliminar la cuenta anonimiza al equipo, borra sus fotos y limpia sus notificaciones (Ley 1581)
describe('eliminar la cuenta: equipo, fotos y notificaciones', () => {
  let ctx: Contexto;
  let carpeta: string;
  const consulta = async (sql: string, valores: unknown[] = []) => (await ctx.pool.query(sql, valores)).rows;
  const eliminar = (token: string, body: unknown) => pedir(ctx, '/api/v1/cuentas/eliminar', { method: 'POST', token, body });

  before(async () => {
    carpeta = mkdtempSync(join(tmpdir(), 'fotos-prueba-'));
    ctx = await iniciar({ entorno: { CARPETA_SUBIDAS: carpeta } });
  });
  after(async () => {
    await ctx.cerrar();
    rmSync(carpeta, { recursive: true, force: true });
  });

  const imagen = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#c0392b' } }).png().toBuffer();

  // Sube una foto al integrante y devuelve la ruta del archivo en disco
  const subirFoto = async (token: string, barberoId: string) => {
    const datos = new FormData();
    datos.append('foto', new Blob([new Uint8Array(await imagen())], { type: 'image/png' }), 'foto.png');
    const r = await fetch(`${ctx.url}/api/v1/equipo/${barberoId}/foto`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: datos });
    assert.equal(r.status, 200, await r.text());
    const { rows } = await ctx.pool.query<{ foto_url: string }>('SELECT foto_url FROM barberos WHERE id = $1', [barberoId]);
    const ruta = join(carpeta, rows[0].foto_url.replace('/uploads/', ''));
    assert.ok(existsSync(ruta), 'la foto quedó guardada en disco');
    return ruta;
  };

  test('al cerrar el negocio, todo el equipo (también quien ya salió) queda anónimo, sin fotos, celulares ni notificaciones', async () => {
    const r = await registrarEmpresa(ctx, { correo: 'cierre.equipo@central.co', codigoAcceso: 'CIERREEQ', numeroEmpleados: 3 });
    assert.equal(r.estado, 201, r.texto);
    const token = r.json.token as string;
    const empresaId = r.json.empresa.id as string;
    const servicio = await pedir(ctx, '/api/v1/servicios', { method: 'POST', token, body: { nombre: 'Corte', duracionMin: 30, precio: 20000 } });
    const activo = await pedir(ctx, '/api/v1/equipo', {
      method: 'POST', token, body: { nombre: 'Carlos Activo', usuario: 'carlos.activo', clave: 'Clave-segura-1', especialidad: 'Barbero' },
    });
    const salio = await pedir(ctx, '/api/v1/equipo', {
      method: 'POST', token, body: { nombre: 'Luis Que Salió', usuario: 'luis.salio', clave: 'Clave-segura-1', especialidad: 'Colorista' },
    });
    assert.equal(activo.estado, 201, activo.texto);
    assert.equal(salio.estado, 201, salio.texto);
    const fotoActivo = await subirFoto(token, activo.json.id);
    const fotoSalio = await subirFoto(token, salio.json.id);
    // Luis sale del equipo: solo se desactiva, y conserva su nombre, su usuario y su foto
    assert.equal((await pedir(ctx, `/api/v1/equipo/${salio.json.id}`, { method: 'DELETE', token })).estado, 200);

    // Carlos tiene un celular registrado y recibe el aviso de una cita nueva
    const tokenCarlos = await iniciarSesion(ctx, 'carlos.activo', 'Clave-segura-1');
    assert.equal((await pedir(ctx, '/api/v1/dispositivos', { method: 'PUT', token: tokenCarlos, body: { token: 'ExponentPushToken[carlos_celular]' } })).estado, 200);
    const cita = await pedir(ctx, '/api/v1/citas', {
      method: 'POST',
      body: reservaValida({ empresaId, barberoId: activo.json.id, servicioId: servicio.json.id, fecha: fechaHabilEnDias(2), nombre: 'Cliente Del Cierre', telefono: '3100000501' }),
    });
    assert.equal(cita.estado, 201, cita.texto);
    await esperarHasta(async () => (await consulta('SELECT 1 FROM notificaciones WHERE barbero_id = $1', [activo.json.id])).length > 0);

    const ok = await eliminar(token, { clave: CLAVE_ADMIN, eliminarNegocio: true });
    assert.equal(ok.estado, 200, ok.texto);

    const equipo = await consulta(
      'SELECT nombre, usuario, password_hash, especialidad, foto_url, activo, atiende_clientes FROM barberos WHERE empresa_id = $1 ORDER BY id',
      [empresaId],
    );
    assert.equal(equipo.length, 2);
    for (const m of equipo) {
      assert.deepEqual(m, { nombre: 'Profesional eliminado', usuario: null, password_hash: null, especialidad: null, foto_url: null, activo: false, atiende_clientes: false });
    }
    assert.ok(!existsSync(fotoActivo), 'la foto del integrante se borró del servidor');
    assert.ok(!existsSync(fotoSalio), 'la foto de quien ya había salido también');
    const ids = [activo.json.id, salio.json.id];
    assert.equal((await consulta('SELECT count(*)::int AS n FROM dispositivos_push WHERE barbero_id = ANY($1)', [ids]))[0].n, 0);
    assert.equal((await consulta('SELECT count(*)::int AS n FROM notificaciones WHERE barbero_id = ANY($1)', [ids]))[0].n, 0);
    // Nadie del equipo puede volver a entrar
    assert.equal((await pedir(ctx, '/api/v1/auth/login', { method: 'POST', body: { usuario: 'carlos.activo', clave: 'Clave-segura-1' } })).estado, 401);
    assert.equal((await pedir(ctx, '/api/v1/citas/agenda', { token: tokenCarlos })).estado, 401);
    // Las citas y la cartera se conservan, a nombre de "Profesional eliminado"
    const citas = await consulta(
      'SELECT b.nombre AS profesional, cl.nombre AS cliente FROM citas c JOIN barberos b ON b.id = c.barbero_id JOIN clientes cl ON cl.id = c.cliente_id WHERE c.empresa_id = $1',
      [empresaId],
    );
    assert.deepEqual(citas, [{ profesional: 'Profesional eliminado', cliente: 'Cliente eliminado' }]);
  });

  test('si el negocio sigue, solo se anonimiza el perfil de quien se va y el nombre de la administradora del negocio', async () => {
    const r = await registrarEmpresa(ctx, { correo: 'sigue@central.co', codigoAcceso: 'SIGUEEQ', nombreAdministradora: 'Ana Que Se Va', numeroEmpleados: 3 });
    assert.equal(r.estado, 201, r.texto);
    const token = r.json.token as string;
    const empresaId = r.json.empresa.id as string;
    const otro = await pedir(ctx, '/api/v1/equipo', {
      method: 'POST', token, body: { nombre: 'Segunda Admin', usuario: 'segunda.admin', clave: 'Clave-segura-1', rol: 'admin', atiendeClientes: true, especialidad: 'Gerente' },
    });
    assert.equal(otro.estado, 201, otro.texto);
    const fotoOtra = await subirFoto(token, otro.json.id);
    // La administradora que se va también atendía clientes, con foto
    const atiende = await pedir(ctx, '/api/v1/equipo/yo-atiendo', { method: 'PUT', token, body: { atiende: true } });
    assert.equal(atiende.estado, 200, atiende.texto);
    const miPerfil = atiende.json.barberoId as string;
    const fotoMia = await subirFoto(token, miPerfil);
    await ctx.pool.query(
      "INSERT INTO notificaciones (barbero_id, tipo, titulo, texto) VALUES ($1, 'cita_nueva', 'Nueva cita', 'Algo')",
      [miPerfil],
    );
    await ctx.pool.query("INSERT INTO dispositivos_push (token, barbero_id) VALUES ('ExponentPushToken[mi_perfil]', $1)", [miPerfil]);

    const ok = await eliminar(token, { clave: CLAVE_ADMIN });
    assert.equal(ok.estado, 200, ok.texto);

    const [empresa] = await consulta('SELECT estado_suscripcion, nombre_administradora FROM empresas WHERE id = $1', [empresaId]);
    assert.deepEqual(empresa, { estado_suscripcion: 'trial', nombre_administradora: 'Cuenta eliminada' });
    const [perfil] = await consulta('SELECT nombre, especialidad, foto_url, activo, atiende_clientes FROM barberos WHERE id = $1', [miPerfil]);
    assert.deepEqual(perfil, { nombre: 'Profesional eliminado', especialidad: null, foto_url: null, activo: false, atiende_clientes: false });
    assert.ok(!existsSync(fotoMia), 'su foto se borró del servidor');
    assert.equal((await consulta('SELECT count(*)::int AS n FROM notificaciones WHERE barbero_id = $1', [miPerfil]))[0].n, 0);
    assert.equal((await consulta('SELECT count(*)::int AS n FROM dispositivos_push WHERE barbero_id = $1', [miPerfil]))[0].n, 0);
    // La otra administradora no se toca
    const [segunda] = await consulta('SELECT nombre, especialidad, activo FROM barberos WHERE id = $1', [otro.json.id]);
    assert.deepEqual(segunda, { nombre: 'Segunda Admin', especialidad: 'Gerente', activo: true });
    assert.ok(existsSync(fotoOtra), 'la foto de la otra administradora sigue');
    assert.equal((await pedir(ctx, '/api/v1/admin/empresa', { token: await iniciarSesion(ctx, 'segunda.admin', 'Clave-segura-1') })).estado, 200);
  });

  test('al borrar la cuenta de un cliente, las notificaciones del personal dejan de nombrarlo', async () => {
    const registro = await registrarCliente(ctx, 'nombrado@correo.com', CLAVE_CLIENTE, { telefono: '3100000502', nombre: 'Cliente Nombrado' });
    assert.equal(registro.estado, 201, registro.texto);
    const cita = await pedir(ctx, '/api/v1/citas', { method: 'POST', token: registro.json.token, body: reservaValida({ fecha: fechaHabilEnDias(4), hora: '03:00 PM' }) });
    assert.equal(cita.estado, 201, cita.texto);
    const citaId = cita.json.cita.id as string;
    await esperarHasta(async () => (await consulta('SELECT 1 FROM notificaciones WHERE cita_id = $1', [citaId])).length > 0);
    // Una notificación guardada antes de este arreglo, con el nombre dentro del texto
    await ctx.pool.query("UPDATE notificaciones SET texto = 'Cliente Nombrado reservó Corte para el lunes.' WHERE cita_id = $1", [citaId]);

    assert.equal((await eliminar(registro.json.token, { clave: CLAVE_CLIENTE })).estado, 200);
    const textos = (await consulta('SELECT texto FROM notificaciones WHERE cita_id = $1', [citaId])).map((f) => f.texto as string);
    assert.ok(textos.length > 0, 'las notificaciones del personal se conservan');
    for (const texto of textos) assert.ok(!texto.includes('Cliente Nombrado'), texto);
    assert.ok(textos.includes('Cliente eliminado reservó Corte para el lunes.'));
  });
});
