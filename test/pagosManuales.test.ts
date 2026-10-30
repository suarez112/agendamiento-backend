import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { precioPara } from '../src/config/planes.js';
import { type Contexto, crearSuperadmin, iniciar, iniciarSesion, pedir, registrarEmpresa } from './apoyo/servidor.js';

const SUPER = '/api/v1/superadmin/pagos';
const FORMAS_VALIDAS = {
  titular: 'Plataforma Agenda S.A.S.',
  whatsapp: '3001234567',
  nequiNumero: '3009876543',
  llaveBreb: '@agendaya',
  nequiActivo: true,
  llaveBrebActiva: true,
  qrActivo: false,
};

let contador = 0;
type Negocio = { token: string; id: string; usuarioId: string; codigo: string };

describe('pagos manuales (Nequi, llave Bre-B y QR)', () => {
  let ctx: Contexto;
  let superadmin: string;

  const registrar = async (): Promise<Negocio> => {
    const r = await registrarEmpresa(ctx, { correo: `manual${++contador}@central.co` });
    assert.equal(r.estado, 201, r.texto);
    return { token: r.json.token, id: r.json.empresa.id, usuarioId: r.json.usuario.id, codigo: r.json.empresa.codigoAcceso };
  };
  const agregarProfesional = async (n: Negocio, rol = 'empleado') => {
    const usuario = `pro.manual.${++contador}`;
    const r = await pedir(ctx, '/api/v1/equipo', {
      method: 'POST',
      token: n.token,
      body: { nombre: `Profesional ${contador}`, usuario, clave: 'Clave-segura-1', rol },
    });
    assert.equal(r.estado, 201, r.texto);
    return usuario;
  };
  const configurar = (cuerpo: unknown = FORMAS_VALIDAS) => pedir(ctx, `${SUPER}/formas-pago`, { method: 'PATCH', token: superadmin, body: cuerpo });
  const crearOrden = (n: Negocio, cuerpo: unknown = { periodo: 'mensual' }) => pedir(ctx, '/api/v1/pagos/ordenes', { method: 'POST', token: n.token, body: cuerpo });
  const aprobar = (referencia: string, token = superadmin, cuerpo?: unknown) =>
    pedir(ctx, `${SUPER}/ordenes/${referencia}/aprobar`, { method: 'POST', token, body: cuerpo ?? {} });
  const rechazar = (referencia: string, cuerpo: unknown = { motivo: 'No encontramos el pago' }) =>
    pedir(ctx, `${SUPER}/ordenes/${referencia}/rechazar`, { method: 'POST', token: superadmin, body: cuerpo });
  const fila = async (sql: string, params: unknown[] = []) => (await ctx.pool.query(sql, params)).rows;
  const qrValido = () => sharp({ create: { width: 24, height: 24, channels: 3, background: '#000000' } }).png().toBuffer();
  const subirQr = async (tipo: string, contenido: Buffer | string, nombre = 'qr.png', mime = 'image/png', token = superadmin) => {
    const datos = new FormData();
    datos.append('qr', new Blob([new Uint8Array(typeof contenido === "string" ? Buffer.from(contenido) : contenido)], { type: mime }), nombre);
    const r = await fetch(`${ctx.url}${SUPER}/formas-pago/qr/${tipo}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: datos });
    const texto = await r.text();
    return { estado: r.status, json: texto ? JSON.parse(texto) : undefined };
  };

  before(async () => {
    ctx = await iniciar({ entorno: { PROVEEDOR_PAGO: 'manual' } });
    superadmin = await crearSuperadmin(ctx);
  });
  after(() => ctx.cerrar());

  describe('formas de pago (superadmin)', () => {
    test('sin configurar, el negocio no puede crear una orden (503) y el superadmin ve que falta configurar', async () => {
      const n = await registrar();
      const r = await crearOrden(n);
      assert.equal(r.estado, 503);
      assert.match(r.json.error, /todavía no están configuradas/);
      assert.deepEqual((await pedir(ctx, `${SUPER}/formas-pago`, { token: superadmin })).json, { configurada: false });
      assert.equal((await fila('SELECT 1 FROM ordenes_pago WHERE empresa_id = $1', [n.id])).length, 0);
    });

    test('la primera vez exige titular y WhatsApp; guarda quién y cuándo, y deja el cambio en el registro de actividad', async () => {
      assert.equal((await configurar({ nequiNumero: '3009876543', nequiActivo: true })).estado, 400);
      const r = await configurar();
      assert.equal(r.estado, 200, r.texto);
      const f = r.json.formasPago;
      assert.equal(f.whatsapp, '+573001234567');
      assert.equal(f.nequi.numero, '3009876543');
      assert.equal(f.actualizadoPor, 'superadmin@plataforma.co');
      assert.match(f.actualizadoEn, /-05:00$/);
      const actividad = await fila("SELECT superadmin_correo, detalle FROM actividad_superadmin WHERE accion = 'actualizar_formas_pago'");
      assert.equal(actividad[0].superadmin_correo, 'superadmin@plataforma.co');
      // El registro guarda los nombres de los campos, no los datos de pago
      assert.ok(!JSON.stringify(actividad[0].detalle).includes('3009876543'));
    });

    test('no se puede dejar sin ninguna forma de pago activa (API y base de datos)', async () => {
      await configurar();
      const todasApagadas = await configurar({ nequiActivo: false, llaveBrebActiva: false, qrActivo: false });
      assert.equal(todasApagadas.estado, 409);
      assert.match(todasApagadas.json.error, /al menos una forma de pago activa/);
      // Apagar una a una: la última se rechaza
      assert.equal((await configurar({ nequiActivo: false })).estado, 200);
      assert.equal((await configurar({ llaveBrebActiva: false })).estado, 409);
      const estado = (await pedir(ctx, `${SUPER}/formas-pago`, { token: superadmin })).json;
      assert.equal(estado.llaveBreb.activa, true);
      // La base también lo impide, aunque alguien se salte la API
      await assert.rejects(
        ctx.pool.query('UPDATE formas_pago_manual SET nequi_activo = false, llave_breb_activa = false, qr_activo = false'),
        { code: '23514' },
      );
      await configurar({ nequiActivo: true });
    });

    test('una forma solo se activa si tiene sus datos: Nequi sin número, llave sin llave y QR sin imagen se rechazan', async () => {
      await configurar({ nequiNumero: null, nequiActivo: false });
      assert.equal((await configurar({ nequiActivo: true })).estado, 400);
      assert.equal((await configurar({ qrActivo: true })).estado, 400);
      await configurar({ nequiNumero: '3009876543', nequiActivo: true });
    });

    test('valida los datos: número de Nequi, WhatsApp, llave y booleanos', async () => {
      for (const cuerpo of [
        { nequiNumero: '12345' },
        { nequiNumero: '2009876543' },
        { whatsapp: 'no-es-un-numero' },
        { llaveBreb: 'ab' },
        { nequiActivo: 'si' },
        {},
      ]) {
        assert.equal((await configurar(cuerpo)).estado, 400, JSON.stringify(cuerpo));
      }
    });

    test('solo el superadmin cambia las formas de pago: un administrador de negocio y quien no tiene sesión no pueden', async () => {
      const n = await registrar();
      for (const token of [n.token, '']) {
        assert.equal((await pedir(ctx, `${SUPER}/formas-pago`, { method: 'PATCH', token, body: { titular: 'Otro' } })).estado, 401);
        assert.equal((await pedir(ctx, `${SUPER}/formas-pago`, { token })).estado, 401);
      }
      assert.equal((await subirQr('nequi', await qrValido(), 'qr.png', 'image/png', n.token)).estado, 401);
      assert.notEqual((await fila('SELECT titular FROM formas_pago_manual'))[0].titular, 'Otro');
    });
  });

  describe('códigos QR', () => {
    test('rechaza un archivo falso aunque se llame .png y diga image/png', async () => {
      await configurar();
      const falso = await subirQr('nequi', 'esto no es una imagen, es texto', 'qr.png', 'image/png');
      assert.equal(falso.estado, 400);
      assert.match(falso.json.error, /JPG, PNG o WEBP/);
      // Firma de PNG pero sin una imagen válida detrás
      const firma = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('basura que no se puede decodificar')]);
      assert.equal((await subirQr('breb', firma)).estado, 400);
      // Otro tipo de archivo real (GIF) tampoco sirve
      assert.equal((await subirQr('breb', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;'), 'qr.png', 'image/png')).estado, 400);
      const guardado = await fila('SELECT qr_nequi, qr_breb FROM formas_pago_manual');
      assert.equal(guardado[0].qr_nequi, null);
      assert.equal(guardado[0].qr_breb, null);
    });

    test('rechaza una imagen de más de 1 MB (413) y sin archivo (400)', async () => {
      const relleno = Buffer.concat([await qrValido(), Buffer.alloc(1024 * 1024 + 10)]);
      assert.equal((await subirQr('nequi', relleno)).estado, 413);
      const vacio = await fetch(`${ctx.url}${SUPER}/formas-pago/qr/nequi`, { method: 'PUT', headers: { Authorization: `Bearer ${superadmin}` }, body: new FormData() });
      assert.equal(vacio.status, 400);
    });

    test('acepta una imagen real, conserva su tipo y la entrega solo a quien tiene sesión y solo si la forma QR está activa', async () => {
      const n = await registrar();
      const png = await qrValido();
      const subida = await subirQr('nequi', png);
      assert.equal(subida.estado, 200, JSON.stringify(subida.json));
      assert.equal(subida.json.formasPago.qr.nequi, true);
      assert.equal((await configurar({ qrActivo: true })).estado, 200);

      const imagen = await fetch(`${ctx.url}/api/v1/pagos/formas-pago/qr/nequi`, { headers: { Authorization: `Bearer ${n.token}` } });
      assert.equal(imagen.status, 200);
      assert.equal(imagen.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await imagen.arrayBuffer()), png);
      // Nunca pública
      assert.equal((await fetch(`${ctx.url}/api/v1/pagos/formas-pago/qr/nequi`)).status, 401);
      // El QR de Bre-B no existe todavía
      assert.equal((await fetch(`${ctx.url}/api/v1/pagos/formas-pago/qr/breb`, { headers: { Authorization: `Bearer ${n.token}` } })).status, 404);
      // Si el superadmin desactiva la forma QR, el negocio ya no la ve
      await configurar({ qrActivo: false });
      assert.equal((await fetch(`${ctx.url}/api/v1/pagos/formas-pago/qr/nequi`, { headers: { Authorization: `Bearer ${n.token}` } })).status, 404);
    });

    test('no se puede borrar el único QR mientras la forma QR esté activa', async () => {
      await configurar({ qrActivo: true });
      const r = await pedir(ctx, `${SUPER}/formas-pago/qr/nequi`, { method: 'DELETE', token: superadmin });
      assert.equal(r.estado, 409);
      await configurar({ qrActivo: false });
      assert.equal((await pedir(ctx, `${SUPER}/formas-pago/qr/nequi`, { method: 'DELETE', token: superadmin })).estado, 200);
    });
  });

  describe('lo que ve el administrador del negocio', () => {
    test('solo las formas activas, con el WhatsApp; nunca de forma pública ni para un empleado', async () => {
      const n = await registrar();
      await subirQr('nequi', await qrValido());
      await configurar({ nequiActivo: true, llaveBrebActiva: false, qrActivo: false });
      const r = await pedir(ctx, '/api/v1/pagos/formas-pago', { token: n.token });
      assert.equal(r.estado, 200);
      assert.deepEqual(r.json.formas, [{ tipo: 'nequi', numero: '3009876543' }]);
      assert.equal(r.json.whatsapp, '+573001234567');
      assert.equal(r.json.whatsappUrl, 'https://wa.me/573001234567');
      assert.ok(!r.texto.includes('@agendaya'), 'la llave desactivada no se muestra');

      await configurar({ llaveBrebActiva: true, qrActivo: true });
      const todas = (await pedir(ctx, '/api/v1/pagos/formas-pago', { token: n.token })).json.formas;
      assert.deepEqual(todas.map((f: { tipo: string }) => f.tipo), ['nequi', 'llave_breb', 'qr']);
      assert.match(todas[2].imagenes[0].url, /\/api\/v1\/pagos\/formas-pago\/qr\/nequi$/);

      assert.equal((await pedir(ctx, '/api/v1/pagos/formas-pago')).estado, 401);
      const usuario = await agregarProfesional(n);
      const empleado = await iniciarSesion(ctx, usuario, 'Clave-segura-1');
      assert.equal((await pedir(ctx, '/api/v1/pagos/formas-pago', { token: empleado })).estado, 403);
      // El endpoint público de configuración no expone ningún dato de pago
      const publico = await pedir(ctx, '/api/v1/pagos/configuracion');
      assert.deepEqual(publico.json, { disponible: true, proveedor: 'manual', esDePrueba: false });
      await configurar({ qrActivo: false });
    });
  });

  describe('órdenes de pago', () => {
    before(async () => {
      await configurar({ nequiActivo: true, llaveBrebActiva: true, qrActivo: false });
    });

    test('el monto siempre lo calcula el servidor con los profesionales activos: lo que mande la app se ignora', async () => {
      const n = await registrar();
      const sola = await crearOrden(n, { periodo: 'mensual', monto: 1, profesionales: 10, precio: 5 });
      assert.equal(sola.estado, 201, sola.texto);
      assert.equal(sola.json.monto, precioPara(1, 'mensual'));
      assert.equal(sola.json.profesionales, 1);

      await agregarProfesional(n);
      await agregarProfesional(n);
      const tres = await crearOrden(n, { periodo: 'anual', monto: 1 });
      assert.equal(tres.json.monto, precioPara(2, 'anual'));
      assert.equal(tres.json.profesionales, 2);
      assert.equal(tres.json.plan.id, 'equipo');
      const [guardada] = await fila('SELECT monto_centavos, profesionales FROM ordenes_pago WHERE referencia = $1', [tres.json.referencia]);
      assert.equal(Number(guardada.monto_centavos), precioPara(2, 'anual') * 100);
      assert.equal(guardada.profesionales, 2);
    });

    test('la orden queda pendiente de verificación e incluye lo necesario para armar el mensaje de WhatsApp', async () => {
      const n = await registrar();
      const r = await crearOrden(n, { periodo: 'mensual' });
      assert.equal(r.estado, 201);
      assert.equal(r.json.estado, 'pendiente');
      assert.equal(r.json.estadoTexto, 'Pendiente de verificación');
      assert.equal(r.json.proveedor, 'manual');
      assert.equal(r.json.negocio.nombre, 'Barbería Central');
      assert.equal(r.json.negocio.codigoAcceso, n.codigo);
      assert.deepEqual(r.json.plan, { id: 'emprendedor', nombre: 'Emprendedor' });
      assert.equal(r.json.periodo, 'mensual');
      assert.equal(r.json.monto, precioPara(1, 'mensual'));
      assert.equal(r.json.moneda, 'COP');
      assert.deepEqual(r.json.pago.formas.map((f: { tipo: string }) => f.tipo), ['nequi', 'llave_breb']);
      assert.equal(r.json.pago.whatsapp, '+573001234567');
      assert.equal(r.json.pago.titular, 'Plataforma Agenda S.A.S.');
      assert.match(r.json.referencia, /^AGD-[A-Z0-9]+-[A-F0-9]{24}$/);
      // No cambia la suscripción hasta que el superadmin apruebe
      assert.equal((await fila('SELECT estado_suscripcion FROM empresas WHERE id = $1', [n.id]))[0].estado_suscripcion, 'trial');
    });

    test('valida el periodo y exige ser administrador', async () => {
      const n = await registrar();
      for (const cuerpo of [{}, { periodo: 'semanal' }, { profesionales: 3 }, { periodo: 3 }]) {
        assert.equal((await crearOrden(n, cuerpo)).estado, 400, JSON.stringify(cuerpo));
      }
      assert.equal((await crearOrden({ ...n, token: '' })).estado, 401);
      const usuario = await agregarProfesional(n);
      const empleado = await iniciarSesion(ctx, usuario, 'Clave-segura-1');
      assert.equal((await crearOrden({ ...n, token: empleado })).estado, 403);
    });

    test('una orden nueva anula la anterior: solo queda una pendiente por negocio', async () => {
      const n = await registrar();
      const primera = await crearOrden(n, { periodo: 'mensual' });
      const segunda = await crearOrden(n, { periodo: 'anual' });
      assert.equal(segunda.estado, 201);
      const estados = await fila('SELECT referencia, estado, motivo_revision FROM ordenes_pago WHERE empresa_id = $1 ORDER BY id', [n.id]);
      assert.deepEqual(estados.map((e) => e.estado), ['anulada', 'pendiente']);
      assert.equal(estados[0].referencia, primera.json.referencia);
      assert.equal((await pedir(ctx, `/api/v1/pagos/ordenes/${primera.json.referencia}`, { token: n.token })).json.estado, 'anulada');
      // La anulada ya no se puede aprobar
      const intento = await aprobar(primera.json.referencia);
      assert.equal(intento.estado, 409);
      assert.equal((await fila('SELECT estado_suscripcion FROM empresas WHERE id = $1', [n.id]))[0].estado_suscripcion, 'trial');
      // Dos solicitudes a la vez tampoco dejan dos pendientes
      await Promise.all([crearOrden(n), crearOrden(n), crearOrden(n)]);
      assert.equal(Number((await fila("SELECT count(*) FROM ordenes_pago WHERE empresa_id = $1 AND estado = 'pendiente'", [n.id]))[0].count), 1);
    });

    test('un negocio solo ve sus propias órdenes', async () => {
      const a = await registrar();
      const b = await registrar();
      const ordenA = await crearOrden(a);
      const ordenB = await crearOrden(b);
      assert.equal((await pedir(ctx, `/api/v1/pagos/ordenes/${ordenA.json.referencia}`, { token: a.token })).estado, 200);
      assert.equal((await pedir(ctx, `/api/v1/pagos/ordenes/${ordenA.json.referencia}`, { token: b.token })).estado, 404);
      assert.equal((await pedir(ctx, `/api/v1/pagos/ordenes/${ordenB.json.referencia}`, { token: a.token })).estado, 404);
      const lista = (await pedir(ctx, '/api/v1/pagos/ordenes', { token: b.token })).json;
      assert.deepEqual(lista.map((o: { referencia: string }) => o.referencia), [ordenB.json.referencia]);
      assert.equal((await pedir(ctx, '/api/v1/pagos/ordenes')).estado, 401);
    });

    test('limita la creación de órdenes por conexión', async () => {
      const limitado = await iniciar({ entorno: { PROVEEDOR_PAGO: 'manual' }, limites: { ordenesPago: 2 } });
      try {
        const token = await crearSuperadmin(limitado);
        await pedir(limitado, `${SUPER}/formas-pago`, { method: 'PATCH', token, body: FORMAS_VALIDAS });
        const registro = await registrarEmpresa(limitado, { correo: 'limite@central.co' });
        const estados = [];
        for (let i = 0; i < 3; i++) {
          estados.push((await pedir(limitado, '/api/v1/pagos/ordenes', { method: 'POST', token: registro.json.token, body: { periodo: 'mensual' } })).estado);
        }
        assert.deepEqual(estados, [201, 201, 429]);
      } finally {
        await limitado.cerrar();
      }
    });
  });

  describe('verificación del superadmin', () => {
    test('la lista de pendientes trae negocio, plan, periodo, monto, fecha y contacto del administrador', async () => {
      const n = await registrar();
      const orden = await crearOrden(n, { periodo: 'anual' });
      const lista = await pedir(ctx, `${SUPER}/ordenes`, { token: superadmin });
      assert.equal(lista.estado, 200);
      const item = lista.json.datos.find((o: { referencia: string }) => o.referencia === orden.json.referencia);
      assert.ok(item, 'la orden aparece entre las pendientes');
      assert.equal(item.negocio.codigoAcceso, n.codigo);
      assert.equal(item.negocio.nombre, 'Barbería Central');
      assert.equal(item.plan.id, 'emprendedor');
      assert.equal(item.periodo, 'anual');
      assert.equal(item.monto, precioPara(1, 'anual'));
      assert.match(item.creadaEn, /-05:00$/);
      assert.equal(item.contacto.administradora, 'Ana Pérez');
      assert.match(item.contacto.correo, /@central\.co$/);
      assert.ok(lista.json.datos.every((o: { estado: string }) => o.estado === 'pendiente'));
      assert.equal((await pedir(ctx, `${SUPER}/ordenes?estado=otra`, { token: superadmin })).estado, 400);
    });

    test('quien no es superadmin no puede aprobar ni rechazar: administrador de negocio, empleado y sin sesión', async () => {
      const n = await registrar();
      const orden = await crearOrden(n);
      const usuario = await agregarProfesional(n);
      const empleado = await iniciarSesion(ctx, usuario, 'Clave-segura-1');
      for (const token of [n.token, empleado, '']) {
        assert.equal((await aprobar(orden.json.referencia, token)).estado, 401);
        assert.equal(
          (await pedir(ctx, `${SUPER}/ordenes/${orden.json.referencia}/rechazar`, { method: 'POST', token, body: { motivo: 'x' } })).estado,
          401,
        );
        assert.equal((await pedir(ctx, `${SUPER}/ordenes`, { token })).estado, 401);
      }
      const [guardada] = await fila('SELECT estado, activada_en FROM ordenes_pago WHERE referencia = $1', [orden.json.referencia]);
      assert.equal(guardada.estado, 'pendiente');
      assert.equal(guardada.activada_en, null);
      assert.equal((await fila('SELECT estado_suscripcion FROM empresas WHERE id = $1', [n.id]))[0].estado_suscripcion, 'trial');
    });

    test('aprobar activa el plan por el periodo pagado, registra quién y cuándo y avisa al administrador', async () => {
      const n = await registrar();
      await agregarProfesional(n);
      const orden = await crearOrden(n, { periodo: 'anual' });
      const r = await aprobar(orden.json.referencia, superadmin, { motivo: 'Comprobante verificado' });
      assert.equal(r.estado, 200, r.texto);
      assert.equal(r.json.orden.estado, 'aprobada');

      const [e] = await fila(
        `SELECT estado_suscripcion, plan_suscripcion, plan_equipo, profesionales_pagados,
                to_char(suscripcion_fin, 'YYYY-MM-DD') AS fin, to_char((trial_ends_at AT TIME ZONE zona_horaria)::date + interval '1 year', 'YYYY-MM-DD') AS fin_esperado
         FROM empresas WHERE id = $1`,
        [n.id],
      );
      assert.equal(e.estado_suscripcion, 'activa');
      assert.equal(e.plan_suscripcion, 'anual');
      assert.equal(e.profesionales_pagados, 1);
      // Pagó durante la prueba: el año cuenta desde el fin de la prueba
      assert.equal(e.fin, e.fin_esperado);

      const [o] = await fila('SELECT estado, activada_en, revisada_por_correo, revisada_en, motivo_revision FROM ordenes_pago WHERE referencia = $1', [orden.json.referencia]);
      assert.equal(o.estado, 'aprobada');
      assert.ok(o.activada_en && o.revisada_en);
      assert.equal(o.revisada_por_correo, 'superadmin@plataforma.co');
      assert.equal(o.motivo_revision, 'Comprobante verificado');

      const [act] = await fila("SELECT origen, precio, profesionales FROM activaciones_plan WHERE empresa_id = $1", [n.id]);
      assert.equal(act.origen, 'manual');
      assert.equal(Number(act.precio), precioPara(1, 'anual'));
      const [reg] = await fila("SELECT superadmin_correo, motivo, referencia FROM actividad_superadmin WHERE accion = 'aprobar_pago_manual' AND empresa_id = $1", [n.id]);
      assert.equal(reg.superadmin_correo, 'superadmin@plataforma.co');
      assert.equal(reg.motivo, 'Comprobante verificado');
      assert.equal(reg.referencia, orden.json.referencia);

      const avisos = await fila("SELECT tipo, titulo FROM notificaciones WHERE usuario_id = $1 AND tipo = 'pago_aprobado'", [n.usuarioId]);
      assert.equal(avisos.length, 1);
      // El negocio ve el resultado en su orden
      const vista = (await pedir(ctx, `/api/v1/pagos/ordenes/${orden.json.referencia}`, { token: n.token })).json;
      assert.equal(vista.estado, 'aprobada');
      assert.equal(vista.pago, undefined);
    });

    test('la doble aprobación activa una sola vez: un segundo clic responde 409 y no extiende la suscripción', async () => {
      const n = await registrar();
      const orden = await crearOrden(n, { periodo: 'mensual' });
      assert.equal((await aprobar(orden.json.referencia)).estado, 200);
      const despuesDeLaPrimera = (await fila('SELECT suscripcion_fin FROM empresas WHERE id = $1', [n.id]))[0].suscripcion_fin;
      const segunda = await aprobar(orden.json.referencia);
      assert.equal(segunda.estado, 409);
      assert.match(segunda.json.error, /ya está aprobada/);
      assert.equal(String((await fila('SELECT suscripcion_fin FROM empresas WHERE id = $1', [n.id]))[0].suscripcion_fin), String(despuesDeLaPrimera));
      assert.equal((await fila('SELECT 1 FROM activaciones_plan WHERE empresa_id = $1', [n.id])).length, 1);
      assert.equal((await fila("SELECT 1 FROM notificaciones WHERE usuario_id = $1 AND tipo = 'pago_aprobado'", [n.usuarioId])).length, 1);
    });

    test('dos aprobaciones al mismo tiempo: una sola gana', async () => {
      const n = await registrar();
      const orden = await crearOrden(n, { periodo: 'mensual' });
      const respuestas = await Promise.all(Array.from({ length: 5 }, () => aprobar(orden.json.referencia)));
      assert.deepEqual(respuestas.map((r) => r.estado).sort(), [200, 409, 409, 409, 409]);
      assert.equal((await fila('SELECT 1 FROM activaciones_plan WHERE empresa_id = $1', [n.id])).length, 1);
      assert.equal((await fila("SELECT 1 FROM actividad_superadmin WHERE accion = 'aprobar_pago_manual' AND empresa_id = $1", [n.id])).length, 1);
      // Un mes desde hoy o desde el fin de la prueba, nunca dos
      const [e] = await fila(
        `SELECT (suscripcion_fin - ((trial_ends_at AT TIME ZONE zona_horaria)::date))::int AS dias FROM empresas WHERE id = $1`,
        [n.id],
      );
      assert.ok(e.dias >= 28 && e.dias <= 31, `dias=${e.dias}`);
    });

    test('rechazar no cambia la suscripción, exige motivo, queda registrado y avisa al administrador', async () => {
      const n = await registrar();
      const antes = (await fila('SELECT estado_suscripcion, plan_suscripcion, suscripcion_fin, trial_ends_at FROM empresas WHERE id = $1', [n.id]))[0];
      const orden = await crearOrden(n);
      assert.equal((await rechazar(orden.json.referencia, {})).estado, 400);
      assert.equal((await rechazar(orden.json.referencia, { motivo: '   ' })).estado, 400);

      const r = await rechazar(orden.json.referencia, { motivo: 'El comprobante no coincide con el monto' });
      assert.equal(r.estado, 200, r.texto);
      assert.equal(r.json.orden.estado, 'rechazada');
      assert.deepEqual((await fila('SELECT estado_suscripcion, plan_suscripcion, suscripcion_fin, trial_ends_at FROM empresas WHERE id = $1', [n.id]))[0], antes);
      assert.equal((await fila('SELECT 1 FROM activaciones_plan WHERE empresa_id = $1', [n.id])).length, 0);

      const [reg] = await fila("SELECT superadmin_correo, motivo FROM actividad_superadmin WHERE accion = 'rechazar_pago_manual' AND empresa_id = $1", [n.id]);
      assert.equal(reg.superadmin_correo, 'superadmin@plataforma.co');
      assert.equal(reg.motivo, 'El comprobante no coincide con el monto');
      const [aviso] = await fila("SELECT titulo, texto FROM notificaciones WHERE usuario_id = $1 AND tipo = 'pago_rechazado'", [n.usuarioId]);
      assert.equal(aviso.titulo, 'Pago rechazado');
      // La push y la notificación no repiten el motivo; el negocio lo consulta en la orden
      assert.ok(!aviso.texto.includes('comprobante no coincide'));
      const vista = (await pedir(ctx, `/api/v1/pagos/ordenes/${orden.json.referencia}`, { token: n.token })).json;
      assert.equal(vista.estado, 'rechazada');
      assert.equal(vista.motivoRevision, 'El comprobante no coincide con el monto');

      // Una orden ya rechazada no se puede aprobar ni rechazar otra vez
      assert.equal((await aprobar(orden.json.referencia)).estado, 409);
      assert.equal((await rechazar(orden.json.referencia)).estado, 409);
      // Y el negocio puede crear una orden nueva
      assert.equal((await crearOrden(n)).estado, 201);
    });

    test('una referencia que no existe responde 404', async () => {
      assert.equal((await aprobar('AGD-NOEXISTE-000000000000000000000000')).estado, 404);
      assert.equal((await rechazar('AGD-NOEXISTE-000000000000000000000000')).estado, 404);
    });

    test('un negocio cancelado no se activa al aprobar', async () => {
      const n = await registrar();
      const orden = await crearOrden(n);
      await ctx.pool.query("UPDATE empresas SET estado_suscripcion = 'cancelada' WHERE id = $1", [n.id]);
      assert.equal((await aprobar(orden.json.referencia)).estado, 409);
      assert.equal((await fila('SELECT estado FROM ordenes_pago WHERE referencia = $1', [orden.json.referencia]))[0].estado, 'pendiente');
    });
  });
});
