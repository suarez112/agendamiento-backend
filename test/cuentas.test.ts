import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  CLAVE_ADMIN,
  CLAVE_CLIENTE,
  type Contexto,
  horarioValido,
  iniciar,
  iniciarSesion,
  iniciarSesionCuenta,
  pedir,
  registrarCliente,
  registrarEmpresa,
} from './apoyo/servidor.js';

const MENSAJE_CLAVE =
  'La contraseña debe tener entre 8 y 64 caracteres e incluir una mayúscula, una minúscula, un número y un carácter especial';
const DEBE_ACEPTAR = 'Debes aceptar la Política de Tratamiento de Datos y los Términos y Condiciones';
const MENSAJE_EMPLEADOS = 'El número de empleados debe ser un número entero entre 1 y 10';

// S1, S2, S3, S7 — registro de empresas y clientes, login de cuentas
describe('registro de empresa', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  const contar = async (tabla: 'empresas' | 'usuarios' | 'auditoria_autorizaciones') =>
    Number((await ctx.pool.query(`SELECT count(*) FROM ${tabla}`)).rows[0].count);

  test('crea la empresa en prueba de 15 días y su administradora', async () => {
    const r = await registrarEmpresa(ctx, { codigoAcceso: 'central1', usuario: 'ana.perez' });
    assert.equal(r.estado, 201);
    assert.equal(typeof r.json.token, 'string');
    assert.equal(r.json.usuario.correo, 'admin@central.co');
    assert.equal(r.json.usuario.usuario, 'ana.perez');
    assert.equal(r.json.usuario.rol, 'admin');
    assert.equal(r.json.usuario.empresaId, r.json.empresa.id);
    assert.equal(r.json.empresa.nombre, 'Barbería Central');
    assert.equal(r.json.empresa.codigoAcceso, 'CENTRAL1', 'el código se guarda en mayúsculas');
    assert.ok(r.json.empresa.enlacePublico.endsWith('/CENTRAL1'));
    assert.equal(r.json.empresa.estadoSuscripcion, 'trial');
    assert.equal(r.json.empresa.diasPruebaRestantes, 15);
    assert.equal(r.json.empresa.zonaHoraria, 'America/Bogota');
    assert.equal(r.json.usuario.clave, undefined, 'nunca devuelve la contraseña');

    const { rows } = await ctx.pool.query(
      `SELECT e.estado_suscripcion, e.numero_empleados, e.nombre_administradora, e.departamento, e.ciudad,
              e.pais, e.zona_horaria,
              e.trial_ends_at BETWEEN now() + interval '15 days' - interval '1 minute'
                                  AND now() + interval '15 days' AS prueba_15_dias,
              u.rol, u.password_hash
       FROM empresas e JOIN usuarios u ON u.empresa_id = e.id
       WHERE e.id = $1`,
      [r.json.empresa.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].estado_suscripcion, 'trial');
    assert.equal(rows[0].prueba_15_dias, true);
    assert.equal(rows[0].numero_empleados, 4);
    assert.equal(rows[0].nombre_administradora, 'Ana Pérez');
    assert.equal(rows[0].departamento, 'SANTANDER', 'se guarda con el nombre oficial de la lista DIVIPOLA');
    assert.equal(rows[0].ciudad, 'BUCARAMANGA');
    assert.deepEqual([rows[0].pais, rows[0].zona_horaria], ['CO', 'America/Bogota']);
    assert.equal(rows[0].rol, 'admin');
    assert.match(rows[0].password_hash, /^\$2[aby]\$12\$/);

    // El horario por día se guarda: domingo cerrado, de lunes a sábado 08:00 a 19:00
    const horario = await ctx.pool.query(
      `SELECT dia_semana, to_char(hora_apertura, 'HH24:MI') AS apertura, to_char(hora_cierre, 'HH24:MI') AS cierre
       FROM horarios_empresa WHERE empresa_id = $1 ORDER BY dia_semana`,
      [r.json.empresa.id],
    );
    assert.deepEqual(
      horario.rows,
      [1, 2, 3, 4, 5, 6].map((dia_semana) => ({ dia_semana, apertura: '08:00', cierre: '19:00' })),
    );

    // Los clientes ya pueden encontrar el negocio con su código
    const publico = await pedir(ctx, '/api/v1/empresas/validar/central1');
    assert.equal(publico.estado, 200);
    assert.equal(publico.json.empresa.id, r.json.empresa.id);
  });

  test('el logo es opcional y la categoría debe ser una categoría activa', async () => {
    const sinLogo = await registrarEmpresa(ctx, { correo: 'sin-logo@central.co', logoUrl: undefined });
    assert.equal(sinLogo.estado, 201);

    // No distingue mayúsculas y se guarda con el nombre oficial
    const minusculas = await registrarEmpresa(ctx, { correo: 'minusculas@central.co', categoria: 'barbería' });
    assert.equal(minusculas.estado, 201);
    const { rows } = await ctx.pool.query('SELECT categoria FROM empresas WHERE id = $1', [minusculas.json.empresa.id]);
    assert.equal(rows[0].categoria, 'Barbería');

    const antes = await contar('empresas');
    const inventada = await registrarEmpresa(ctx, { correo: 'inventada@central.co', categoria: 'Tienda de mascotas' });
    assert.equal(inventada.estado, 400);
    assert.deepEqual(inventada.json, { error: 'La categoría no es válida. Elige una de la lista.' });
    assert.equal(await contar('empresas'), antes);
  });

  test('exige los campos obligatorios', async () => {
    const antes = await contar('empresas');
    const casos: [Record<string, unknown>, string][] = [
      [{ ciudad: undefined }, 'El campo "ciudad" es obligatorio'],
      [{ nombre: '   ' }, 'El campo "nombre" es obligatorio'],
      [{ codigoAcceso: undefined }, 'El campo "código del negocio" es obligatorio'],
      [{ horario: undefined }, 'El campo "horario" es obligatorio'],
    ];
    for (const [cambios, error] of casos) {
      const r = await registrarEmpresa(ctx, { correo: 'falta@central.co', ...cambios });
      assert.equal(r.estado, 400, JSON.stringify(cambios));
      assert.deepEqual(r.json, { error });
    }
    const sinCuerpo = await pedir(ctx, '/api/v1/cuentas/registro/empresa', { method: 'POST' });
    assert.equal(sinCuerpo.estado, 400);
    assert.equal(await contar('empresas'), antes);
  });

  test('el horario por día se valida: horas, siete días y al menos un día abierto', async () => {
    const antes = await contar('empresas');
    for (const [apertura, cierre] of [
      ['18:00', '09:00'],
      ['09:00', '09:00'],
    ]) {
      const r = await registrarEmpresa(ctx, { correo: 'horas@central.co', horario: horarioValido(apertura, cierre) });
      assert.equal(r.estado, 400);
      assert.deepEqual(r.json, { error: 'El lunes, la hora de cierre debe ser posterior a la de apertura' });
    }
    const formato = await registrarEmpresa(ctx, { correo: 'horas@central.co', horario: horarioValido('8am', '19:00') });
    assert.equal(formato.estado, 400);
    assert.deepEqual(formato.json, { error: 'Las horas del horario deben tener el formato HH:MM (24 horas)' });

    const faltanDias = await registrarEmpresa(ctx, { correo: 'horas@central.co', horario: horarioValido().slice(0, 6) });
    assert.equal(faltanDias.estado, 400);
    assert.deepEqual(faltanDias.json, {
      error: 'El horario debe traer los 7 días de la semana (0 = domingo … 6 = sábado), cada uno una sola vez',
    });

    const cerrado = horarioValido().map((d) => ({ dia: d.dia, abierto: false }));
    const nadaAbierto = await registrarEmpresa(ctx, { correo: 'horas@central.co', horario: cerrado });
    assert.equal(nadaAbierto.estado, 400);
    assert.deepEqual(nadaAbierto.json, { error: 'El negocio debe abrir al menos un día' });
    assert.equal(await contar('empresas'), antes);
  });

  test('el número de empleados debe ser un entero de 1 a 10', async () => {
    for (const numeroEmpleados of [0, -3, 2.5, '4', 11]) {
      const r = await registrarEmpresa(ctx, { correo: 'empleados@central.co', numeroEmpleados });
      assert.equal(r.estado, 400, `numeroEmpleados=${numeroEmpleados}`);
      assert.deepEqual(r.json, { error: MENSAJE_EMPLEADOS });
    }
  });

  test('el correo, el usuario y el código del negocio deben ser válidos', async () => {
    for (const correo of ['sin-arroba', 'a@b', 'dos@@arrobas.co']) {
      const r = await registrarEmpresa(ctx, { correo });
      assert.equal(r.estado, 400, `correo=${correo}`);
      assert.deepEqual(r.json, { error: 'El correo no es válido' });
    }
    for (const usuario of ['ab', 'con espacio', 'x'.repeat(21), 'ñandú.pro']) {
      const r = await registrarEmpresa(ctx, { correo: 'usuario@central.co', usuario });
      assert.equal(r.estado, 400, `usuario=${usuario}`);
      assert.deepEqual(r.json, { error: 'El usuario debe tener entre 4 y 20 caracteres: solo letras, números, punto y guion bajo' });
    }
    for (const codigoAcceso of ['con espacio', 'ñoño', 'DEMASIADOLARGO1', 'a-b']) {
      const r = await registrarEmpresa(ctx, { correo: 'codigo@central.co', codigoAcceso });
      assert.equal(r.estado, 400, `codigo=${codigoAcceso}`);
      assert.deepEqual(r.json, {
        error: 'El código del negocio solo puede tener letras (sin tildes ni ñ) y números, sin espacios, máximo 10 caracteres',
      });
    }
  });

  test('la contraseña nueva exige mayúscula, minúscula, número y carácter especial', async () => {
    const antes = await contar('usuarios');
    for (const clave of ['corta', 'sin-mayuscula-1', 'SIN-MINUSCULA-1', 'Sin-numeros-aqui', 'SinEspecial123', 'x'.repeat(65)]) {
      const r = await registrarEmpresa(ctx, { correo: 'clave@central.co', clave });
      assert.equal(r.estado, 400, `clave=${clave}`);
      assert.deepEqual(r.json, { error: MENSAJE_CLAVE });
    }
    assert.equal(await contar('usuarios'), antes);
  });

  test('la ubicación se valida con la lista oficial de Colombia', async () => {
    const departamento = await registrarEmpresa(ctx, { correo: 'ubicacion@central.co', departamento: 'Atlantida' });
    assert.equal(departamento.estado, 400);
    assert.deepEqual(departamento.json, { error: 'El departamento no es un departamento de Colombia' });
    const ciudad = await registrarEmpresa(ctx, { correo: 'ubicacion@central.co', ciudad: 'Cali' });
    assert.equal(ciudad.estado, 400);
    assert.deepEqual(ciudad.json, { error: 'La ciudad no es un municipio de ese departamento' });
  });

  test('sin aceptar la política de datos y los términos no se crea nada', async () => {
    const empresas = await contar('empresas');
    const usuarios = await contar('usuarios');
    const pruebas = await contar('auditoria_autorizaciones');
    for (const cambios of [
      { aceptaPoliticaDatos: false },
      { aceptaTerminos: false },
      { aceptaPoliticaDatos: undefined },
      { aceptaTerminos: 'true' },
    ]) {
      const r = await registrarEmpresa(ctx, { correo: 'sin-aceptar@central.co', ...cambios });
      assert.equal(r.estado, 400, JSON.stringify(cambios));
      assert.deepEqual(r.json, { error: DEBE_ACEPTAR });
    }
    assert.deepEqual([await contar('empresas'), await contar('usuarios'), await contar('auditoria_autorizaciones')], [empresas, usuarios, pruebas]);
  });

  test('guarda la prueba de la autorización junto con la empresa', async () => {
    const r = await registrarEmpresa(ctx, { correo: 'prueba-legal@central.co' });
    assert.equal(r.estado, 201);
    const { rows } = await ctx.pool.query(
      `SELECT canal, empresa_id, version_politica, version_terminos, ip, user_agent
       FROM auditoria_autorizaciones WHERE usuario_id = $1`,
      [r.json.usuario.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].canal, 'registro_empresa');
    assert.equal(rows[0].empresa_id, r.json.empresa.id);
    assert.ok(rows[0].version_politica && rows[0].version_terminos);
    assert.ok(rows[0].ip, 'guarda la IP de la conexión');
    assert.ok(rows[0].user_agent, 'guarda el navegador o la app');
  });

  test('un correo, un usuario o un código repetidos no crean nada', async () => {
    const primera = await registrarEmpresa(ctx, { correo: 'unica@central.co', codigoAcceso: 'UNICA', usuario: 'usuario.unico' });
    assert.equal(primera.estado, 201);
    const empresas = await contar('empresas');
    const usuarios = await contar('usuarios');
    const pruebas = await contar('auditoria_autorizaciones');

    // Mismo correo con otras mayúsculas: la empresa tampoco debe quedar creada
    const correo = await registrarEmpresa(ctx, { correo: 'UNICA@Central.co' });
    assert.equal(correo.estado, 409);
    assert.deepEqual(correo.json, { error: 'Ya existe una cuenta con ese correo' });

    const codigo = await registrarEmpresa(ctx, { correo: 'otro@central.co', codigoAcceso: 'unica' });
    assert.equal(codigo.estado, 409);
    assert.deepEqual(codigo.json, { error: 'Ese código ya lo usa otro negocio. Elige otro.' });

    const usuario = await registrarEmpresa(ctx, { correo: 'otro2@central.co', usuario: 'USUARIO.UNICO' });
    assert.equal(usuario.estado, 409);
    assert.deepEqual(usuario.json, { error: 'Ese usuario ya está en uso. Elige otro.' });

    assert.deepEqual([await contar('empresas'), await contar('usuarios'), await contar('auditoria_autorizaciones')], [empresas, usuarios, pruebas]);
  });

  test('ignora campos que no le corresponde elegir al usuario', async () => {
    const r = await registrarEmpresa(ctx, {
      correo: 'astuto@central.co',
      id: 'emp_a',
      estadoSuscripcion: 'activa',
      trialEndsAt: '2099-01-01',
      rol: 'cliente',
      nit: '123',
    });
    assert.equal(r.estado, 201);
    assert.notEqual(r.json.empresa.id, 'emp_a');
    assert.equal(r.json.empresa.estadoSuscripcion, 'trial');
    assert.equal(r.json.empresa.diasPruebaRestantes, 15);
    assert.equal(r.json.usuario.rol, 'admin');
  });

  test('la zona horaria sale del país o se envía; sin una zona conocida responde 400', async () => {
    const mexico = await registrarEmpresa(ctx, { correo: 'mx@central.co', pais: 'mx', departamento: 'CDMX', ciudad: 'Ciudad de México' });
    assert.equal(mexico.estado, 201, mexico.texto);
    assert.equal(mexico.json.empresa.zonaHoraria, 'America/Mexico_City');
    assert.equal(mexico.json.empresa.pais, 'MX');
    // Fuera de Colombia, el departamento y la ciudad se guardan tal cual
    const { rows } = await ctx.pool.query('SELECT departamento, ciudad, zona_horaria FROM empresas WHERE id = $1', [mexico.json.empresa.id]);
    assert.deepEqual(rows[0], { departamento: 'CDMX', ciudad: 'Ciudad de México', zona_horaria: 'America/Mexico_City' });
    // El instante de fin de la prueba sale con el desfase de esa zona (México no tiene horario de verano desde 2022)
    assert.match(mexico.json.empresa.trialEndsAt, /-06:00$/);

    const desconocido = await registrarEmpresa(ctx, { correo: 'zz@central.co', pais: 'ZZ' });
    assert.equal(desconocido.estado, 400);
    assert.deepEqual(desconocido.json, {
      error: 'No conocemos la zona horaria de ese país. Envía "zonaHoraria" (ej. America/Bogota)',
    });

    const conZona = await registrarEmpresa(ctx, { correo: 'zz@central.co', pais: 'ZZ', zonaHoraria: 'asia/tokyo' });
    assert.equal(conZona.estado, 201, conZona.texto);
    assert.equal(conZona.json.empresa.zonaHoraria, 'Asia/Tokyo', 'se guarda con el nombre oficial');
    assert.match(conZona.json.empresa.trialEndsAt, /\+09:00$/);

    const invalida = await registrarEmpresa(ctx, { correo: 'zz2@central.co', zonaHoraria: 'Marte/Olympus' });
    assert.equal(invalida.estado, 400);
    assert.deepEqual(invalida.json, { error: 'La zona horaria no es válida. Usa un nombre como America/Bogota' });
  });
});

describe('cuentas de cliente y login', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
    assert.equal((await registrarEmpresa(ctx)).estado, 201);
  });
  after(() => ctx.cerrar());

  test('registra un cliente sin empresa y guarda la prueba de su autorización', async () => {
    const r = await registrarCliente(ctx, '  Cliente@Correo.com ', CLAVE_CLIENTE, { telefono: '300 123 4567' });
    assert.equal(r.estado, 201);
    assert.equal(typeof r.json.token, 'string');
    assert.deepEqual(
      { correo: r.json.usuario.correo, rol: r.json.usuario.rol, empresaId: r.json.usuario.empresaId },
      { correo: 'cliente@correo.com', rol: 'cliente', empresaId: null },
    );
    assert.equal(r.json.usuario.telefono, '+573001234567', 'el teléfono se guarda en formato E.164');
    const { rows } = await ctx.pool.query('SELECT rol, empresa_id, password_hash, telefono FROM usuarios WHERE id = $1', [
      r.json.usuario.id,
    ]);
    assert.equal(rows[0].rol, 'cliente');
    assert.equal(rows[0].empresa_id, null);
    assert.equal(rows[0].telefono, '+573001234567');
    assert.match(rows[0].password_hash, /^\$2[aby]\$12\$/);
    const prueba = await ctx.pool.query('SELECT canal FROM auditoria_autorizaciones WHERE usuario_id = $1', [r.json.usuario.id]);
    assert.deepEqual(prueba.rows, [{ canal: 'registro_cliente' }]);
  });

  test('valida correo, contraseña, teléfono y aceptaciones del cliente', async () => {
    assert.deepEqual((await registrarCliente(ctx, 'malo', CLAVE_CLIENTE)).json, { error: 'El correo no es válido' });
    for (const clave of ['corta', 'sinmayuscula1!', 'MiClave1234', 'Mi-clave-aqui']) {
      const r = await registrarCliente(ctx, 'nuevo@correo.com', clave);
      assert.equal(r.estado, 400, clave);
      assert.deepEqual(r.json, { error: MENSAJE_CLAVE });
    }
    const telefono = await registrarCliente(ctx, 'nuevo@correo.com', CLAVE_CLIENTE, { telefono: '1234' });
    assert.equal(telefono.estado, 400);
    assert.match(telefono.json.error, /^El número de teléfono no es válido/);
    const sinAceptar = await registrarCliente(ctx, 'nuevo@correo.com', CLAVE_CLIENTE, { aceptaTerminos: false });
    assert.deepEqual(sinAceptar.json, { error: DEBE_ACEPTAR });
    const sinNombre = await registrarCliente(ctx, 'nuevo@correo.com', CLAVE_CLIENTE, { nombre: undefined });
    assert.deepEqual(sinNombre.json, { error: 'El campo "nombre" es obligatorio' });
    const sinLogin = await registrarCliente(ctx, undefined, CLAVE_CLIENTE);
    assert.deepEqual(sinLogin.json, { error: 'Envía tu correo o un nombre de usuario para iniciar sesión' });
    const faltan = await pedir(ctx, '/api/v1/cuentas/registro/cliente', { method: 'POST', body: {} });
    assert.equal(faltan.estado, 400);
    const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM usuarios WHERE correo = 'nuevo@correo.com'");
    assert.equal(rows[0].n, 0, 'ningún intento inválido creó la cuenta');
  });

  test('no permite dos cuentas con el mismo correo, usuario o teléfono', async () => {
    const correo = await registrarCliente(ctx, 'CLIENTE@correo.com', 'Otra-clave-123');
    assert.equal(correo.estado, 409);
    assert.deepEqual(correo.json, { error: 'Ya existe una cuenta con ese correo' });
    // Tampoco con el correo de la administradora de una empresa
    assert.equal((await registrarCliente(ctx, 'admin@central.co', 'Otra-clave-123')).estado, 409);

    const telefono = await registrarCliente(ctx, 'otro@correo.com', CLAVE_CLIENTE, { telefono: '+57 300 123 4567' });
    assert.equal(telefono.estado, 409);
    assert.deepEqual(telefono.json, { error: 'Ya existe una cuenta con ese número de teléfono' });

    const conUsuario = await registrarCliente(ctx, undefined, CLAVE_CLIENTE, { usuario: 'juan.gomez' });
    assert.equal(conUsuario.estado, 201);
    const repetido = await registrarCliente(ctx, undefined, CLAVE_CLIENTE, { usuario: 'JUAN.GOMEZ' });
    assert.equal(repetido.estado, 409);
    assert.deepEqual(repetido.json, { error: 'Ese usuario ya está en uso. Elige otro.' });
    // El usuario de la administradora ya está tomado
    const deAdmin = await registrarCliente(ctx, undefined, CLAVE_CLIENTE, { usuario: 'admin.a' });
    assert.equal(deAdmin.estado, 409, 'el usuario de una persona del personal no se puede usar');
  });

  test('el cliente inicia sesión con correo y contraseña', async () => {
    const r = await iniciarSesionCuenta(ctx, 'cliente@CORREO.com', CLAVE_CLIENTE);
    assert.equal(r.estado, 200);
    assert.equal(typeof r.json.token, 'string');
    assert.equal(r.json.usuario.rol, 'cliente');
    assert.equal(r.json.usuario.empresaId, null);
    assert.equal(r.json.debeAceptarDocumentos, false, 'aceptó las versiones vigentes al registrarse');
  });

  test('la administradora inicia sesión con el correo de la empresa', async () => {
    const r = await iniciarSesionCuenta(ctx, 'admin@central.co', CLAVE_ADMIN);
    assert.equal(r.estado, 200);
    assert.equal(r.json.usuario.rol, 'admin');
    assert.equal(typeof r.json.usuario.empresaId, 'string');
  });

  test('correo inexistente y contraseña incorrecta responden igual', async () => {
    const incorrecta = await iniciarSesionCuenta(ctx, 'cliente@correo.com', 'no-es-la-clave');
    const inexistente = await iniciarSesionCuenta(ctx, 'nadie@correo.com', 'no-es-la-clave');
    assert.equal(incorrecta.estado, 401);
    assert.deepEqual(incorrecta.json, { error: 'Correo o contraseña incorrectos' });
    assert.deepEqual(inexistente.json, incorrecta.json);
    assert.equal((await iniciarSesionCuenta(ctx, 'cliente@correo.com', undefined)).estado, 400);
  });

  test('cada tipo de sesión solo sirve donde le corresponde', async () => {
    const cliente = (await iniciarSesionCuenta(ctx, 'cliente@correo.com', CLAVE_CLIENTE)).json.token;
    const admin = (await iniciarSesionCuenta(ctx, 'admin@central.co', CLAVE_ADMIN)).json.token;
    const personal = await iniciarSesion(ctx, 'barbero.a', 'clave-a');

    // El cliente con cuenta no entra a nada del personal
    for (const ruta of ['/api/v1/citas/agenda', '/api/v1/empresas/actual', '/api/v1/equipo']) {
      const r = await pedir(ctx, ruta, { token: cliente });
      assert.equal(r.estado, 403, ruta);
      assert.deepEqual(r.json, { error: 'Esta función es solo para el personal del negocio.' });
    }
    // La cuenta de la administradora cuenta como administradora de SU negocio en los endpoints del personal
    for (const ruta of ['/api/v1/citas/agenda', '/api/v1/empresas/actual', '/api/v1/equipo']) {
      assert.equal((await pedir(ctx, ruta, { token: admin })).estado, 200, ruta);
    }
    // ...pero no usa la cuenta del cliente
    const miCuenta = await pedir(ctx, '/api/v1/mi-cuenta/citas', { token: admin });
    assert.equal(miCuenta.estado, 403);
    assert.deepEqual(miCuenta.json, { error: 'Esta función es solo para clientes con cuenta.' });
    // El token del personal (barberos) no es una cuenta
    assert.equal((await pedir(ctx, '/api/v1/mi-cuenta/citas', { token: personal })).estado, 401);
    assert.equal((await pedir(ctx, '/api/v1/mi-cuenta/citas', { token: cliente })).estado, 200);
    // El login del personal (barberos) sigue igual
    assert.equal(typeof (await iniciarSesion(ctx, 'admin.a', '1234')), 'string');
  });
});
