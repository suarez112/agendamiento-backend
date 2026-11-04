import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import sharp from 'sharp';
import { TAMANOS_FOTO, type TipoFoto } from '../src/modules/empresas/fotos.js';
import { convertirFotos, respaldoDentroDeSubidas, revisarFotos } from '../src/modules/empresas/optimizacionFotos.js';
import { leerConfigPruebas } from './apoyo/configuracionPruebas.js';
import { type Contexto, iniciar, SECRETO_PRUEBAS, SECRETO_RECUPERACION_PRUEBAS, SECRETO_TOTP_PRUEBAS } from './apoyo/servidor.js';

// npm run fotos:optimizar: convierte las fotos ya guardadas a WebP y al tamaño de pantalla, con copia de las originales
describe('optimizar las fotos ya guardadas', () => {
  let ctx: Contexto;
  let raiz: string;
  let subidas: string;
  let respaldo: string;
  const consulta = async (sql: string, valores: unknown[] = []) => (await ctx.pool.query(sql, valores)).rows;

  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  // Cada prueba con carpetas propias y sin fotos en la base
  beforeEach(async () => {
    if (raiz) rmSync(raiz, { recursive: true, force: true });
    raiz = mkdtempSync(join(tmpdir(), 'optimizar-fotos-'));
    subidas = join(raiz, 'uploads');
    respaldo = join(raiz, 'respaldo');
    for (const tabla of ['empresas', 'barberos', 'productos']) await consulta(`UPDATE ${tabla} SET foto_url = NULL`);
  });
  after(() => rmSync(raiz, { recursive: true, force: true }));

  const imagen = (ancho: number, alto: number, formato: 'jpeg' | 'png' | 'webp') =>
    sharp({ create: { width: ancho, height: alto, channels: 3, background: '#16a085' } })[formato]().toBuffer();

  // Guarda un archivo en <subidas>/<tipo>/ y apunta la fila a él, como lo hacía la app antes
  const fotoAntigua = async (tipo: TipoFoto, id: string, datos: Buffer, extension: string) => {
    const archivo = `${randomUUID()}.${extension}`;
    mkdirSync(join(subidas, tipo), { recursive: true });
    writeFileSync(join(subidas, tipo, archivo), datos);
    const ruta = `/uploads/${tipo}/${archivo}`;
    await consulta(`UPDATE ${tipo} SET foto_url = $1 WHERE id = $2`, [ruta, id]);
    return { archivo, ruta, datos };
  };
  const rutaDe = async (tipo: TipoFoto, id: string) => (await consulta(`SELECT foto_url FROM ${tipo} WHERE id = $1`, [id]))[0].foto_url as string;
  const productoId = async () => (await consulta(`INSERT INTO productos (empresa_id, nombre, precio) VALUES ('emp_a', 'Cera', 1000) RETURNING id`))[0].id as string;
  const optimizar = async () => {
    const { pendientes } = await revisarFotos(ctx.pool, subidas);
    return convertirFotos(ctx.pool, pendientes, { carpetaSubidas: subidas, carpetaRespaldo: respaldo });
  };
  const fotografia = () => {
    const leer = (carpeta: string) =>
      existsSync(carpeta) ? readdirSync(carpeta, { recursive: true }).map(String).sort() : [];
    return { subidas: leer(subidas), respaldo: leer(respaldo) };
  };

  test('convierte JPG, PNG y WebP grandes de los tres tipos, guarda copia de las originales y actualiza la base', async () => {
    const producto = await productoId();
    const negocio = await fotoAntigua('empresas', 'emp_a', await imagen(4000, 3000, 'png'), 'png');
    const integrante = await fotoAntigua('barberos', 'barb_a', await imagen(2000, 2500, 'jpeg'), 'jpg');
    const webpGrande = await fotoAntigua('barberos', 'barb_a2', await imagen(1080, 1080, 'webp'), 'webp');
    const deProducto = await fotoAntigua('productos', producto, await imagen(3000, 3000, 'jpeg'), 'jpg');

    const { pendientes } = await revisarFotos(ctx.pool, subidas);
    assert.equal(pendientes.length, 4);
    const r = await convertirFotos(ctx.pool, pendientes, { carpetaSubidas: subidas, carpetaRespaldo: respaldo });
    assert.deepEqual([r.convertidas, r.cambiadas, r.fallidas], [4, 0, 0]);
    assert.ok(r.bytesDespues < r.bytesAntes);

    for (const [tipo, id, antigua] of [
      ['empresas', 'emp_a', negocio],
      ['barberos', 'barb_a', integrante],
      ['barberos', 'barb_a2', webpGrande],
      ['productos', producto, deProducto],
    ] as const) {
      const ruta = await rutaDe(tipo, id);
      assert.match(ruta, new RegExp(`^/uploads/${tipo}/[a-f0-9-]{36}\\.webp$`));
      assert.notEqual(ruta, antigua.ruta);
      const meta = await sharp(readFileSync(join(subidas, ruta.replace('/uploads/', '')))).metadata();
      assert.equal(meta.format, 'webp');
      assert.ok(meta.width! <= TAMANOS_FOTO[tipo].ancho && meta.height! <= TAMANOS_FOTO[tipo].alto, `${tipo}: ${meta.width}x${meta.height}`);
      // La original sale de la carpeta pública y queda idéntica en el respaldo
      assert.equal(existsSync(join(subidas, tipo, antigua.archivo)), false);
      assert.deepEqual(readFileSync(join(respaldo, tipo, antigua.archivo)), antigua.datos);
    }
    // La lista de cambios permite volver atrás: tabla, fila, ruta anterior y nueva
    const cambios = readFileSync(join(respaldo, 'cambios.csv'), 'utf8').trim().split('\n');
    assert.equal(cambios[0], 'tabla,id,ruta_anterior,ruta_nueva');
    assert.equal(cambios.length, 5);
    assert.ok(cambios.includes(`barberos,barb_a,${integrante.ruta},${await rutaDe('barberos', 'barb_a')}`));
    assert.ok(cambios.includes(`empresas,emp_a,${negocio.ruta},${await rutaDe('empresas', 'emp_a')}`));
  });

  test('correrlo otra vez no cambia nada: lo ya optimizado no se toca', async () => {
    await fotoAntigua('barberos', 'barb_a', await imagen(2000, 2500, 'jpeg'), 'jpg');
    await fotoAntigua('empresas', 'emp_a', await imagen(1600, 1200, 'png'), 'png');
    assert.equal((await optimizar()).convertidas, 2);
    const rutas = [await rutaDe('barberos', 'barb_a'), await rutaDe('empresas', 'emp_a')];
    const antes = fotografia();

    const segunda = await revisarFotos(ctx.pool, subidas);
    assert.deepEqual(segunda.pendientes, []);
    assert.deepEqual(segunda.fotos.map((f) => f.estado), ['ya_optimizada', 'ya_optimizada']);
    const r = await convertirFotos(ctx.pool, segunda.pendientes, { carpetaSubidas: subidas, carpetaRespaldo: respaldo });
    assert.deepEqual([r.convertidas, r.cambiadas, r.fallidas], [0, 0, 0]);
    assert.deepEqual([await rutaDe('barberos', 'barb_a'), await rutaDe('empresas', 'emp_a')], rutas);
    assert.deepEqual(fotografia(), antes);
  });

  test('una foto pequeña que ya es WebP, una dirección web, un archivo que falta o uno dañado no se tocan', async () => {
    const pequena = await fotoAntigua('barberos', 'barb_a', await imagen(300, 375, 'webp'), 'webp');
    await consulta(`UPDATE barberos SET foto_url = 'https://cdn.ejemplo.co/carlos.jpg' WHERE id = 'barb_a2'`);
    await consulta(`UPDATE empresas SET foto_url = $1 WHERE id = 'emp_a'`, [`/uploads/empresas/${randomUUID()}.jpg`]);
    const danada = await fotoAntigua('empresas', 'emp_b', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 1)]), 'jpg');
    const rutasAntes = await consulta(`SELECT id, foto_url FROM barberos UNION ALL SELECT id, foto_url FROM empresas ORDER BY id`);

    const { fotos, pendientes } = await revisarFotos(ctx.pool, subidas);
    const estado = (id: string) => fotos.find((f) => f.id === id)?.estado;
    assert.deepEqual(
      [estado('barb_a'), estado('barb_a2'), estado('emp_a'), estado('emp_b')],
      ['ya_optimizada', 'externa', 'sin_archivo', 'ilegible'],
    );
    assert.deepEqual(pendientes, []);
    await convertirFotos(ctx.pool, pendientes, { carpetaSubidas: subidas, carpetaRespaldo: respaldo });
    assert.deepEqual(await consulta(`SELECT id, foto_url FROM barberos UNION ALL SELECT id, foto_url FROM empresas ORDER BY id`), rutasAntes);
    assert.ok(existsSync(join(subidas, 'barberos', pequena.archivo)));
    assert.ok(existsSync(join(subidas, 'empresas', danada.archivo)));
    assert.equal(existsSync(respaldo), false);
  });

  test('si la foto cambió mientras se convertía (otra subida), no se pisa y no queda un archivo de sobra', async () => {
    const antigua = await fotoAntigua('barberos', 'barb_a', await imagen(2000, 2500, 'jpeg'), 'jpg');
    const { pendientes } = await revisarFotos(ctx.pool, subidas);
    const otra = `/uploads/barberos/${randomUUID()}.webp`;
    await consulta(`UPDATE barberos SET foto_url = $1 WHERE id = 'barb_a'`, [otra]);

    const r = await convertirFotos(ctx.pool, pendientes, { carpetaSubidas: subidas, carpetaRespaldo: respaldo });
    assert.deepEqual([r.convertidas, r.cambiadas, r.fallidas], [0, 1, 0]);
    assert.equal(await rutaDe('barberos', 'barb_a'), otra);
    // Solo queda la original (con su copia): la versión convertida se borró
    assert.deepEqual(readdirSync(join(subidas, 'barberos')), [antigua.archivo]);
    assert.deepEqual(readFileSync(join(respaldo, 'barberos', antigua.archivo)), antigua.datos);
  });

  test('una foto que usan dos filas: la original se conserva hasta convertir la última que la usa', async () => {
    const compartida = await fotoAntigua('barberos', 'barb_a', await imagen(2000, 2500, 'jpeg'), 'jpg');
    await consulta(`UPDATE barberos SET foto_url = $1 WHERE id = 'barb_a2'`, [compartida.ruta]);
    const { pendientes } = await revisarFotos(ctx.pool, subidas);
    assert.equal(pendientes.length, 2);

    // Solo la primera: la otra fila sigue apuntando a la original, que no se borra
    const primera = await convertirFotos(ctx.pool, [pendientes[0]], { carpetaSubidas: subidas, carpetaRespaldo: respaldo });
    assert.deepEqual([primera.convertidas, primera.fallidas], [1, 0]);
    assert.equal(await rutaDe('barberos', pendientes[1].id), compartida.ruta);
    assert.ok(existsSync(join(subidas, 'barberos', compartida.archivo)));

    // La segunda también se convierte y entonces sí sale de la carpeta pública
    const segunda = await convertirFotos(ctx.pool, [pendientes[1]], { carpetaSubidas: subidas, carpetaRespaldo: respaldo });
    assert.deepEqual([segunda.convertidas, segunda.fallidas], [1, 0]);
    for (const id of ['barb_a', 'barb_a2']) {
      const ruta = await rutaDe('barberos', id);
      assert.match(ruta, /\.webp$/);
      assert.ok(existsSync(join(subidas, ruta.replace('/uploads/', ''))), ruta);
    }
    assert.equal(existsSync(join(subidas, 'barberos', compartida.archivo)), false);
    assert.deepEqual(readFileSync(join(respaldo, 'barberos', compartida.archivo)), compartida.datos);
  });

  test('la copia nunca puede quedar dentro de la carpeta pública de fotos', async () => {
    assert.equal(respaldoDentroDeSubidas(subidas, join(subidas, 'respaldo')), true);
    assert.equal(respaldoDentroDeSubidas(subidas, subidas), true);
    assert.equal(respaldoDentroDeSubidas(subidas, `${subidas}-respaldo`), false);
    await fotoAntigua('barberos', 'barb_a', await imagen(2000, 2500, 'jpeg'), 'jpg');
    const { pendientes } = await revisarFotos(ctx.pool, subidas);
    await assert.rejects(
      convertirFotos(ctx.pool, pendientes, { carpetaSubidas: subidas, carpetaRespaldo: join(subidas, 'copia') }),
      /no puede estar dentro de la carpeta de fotos/,
    );
    assert.equal(existsSync(join(subidas, 'copia')), false);
  });

  describe('el comando npm run fotos:optimizar', () => {
    const prueba = leerConfigPruebas();
    const ejecutar = (args: string[], entrada: string) =>
      new Promise<{ codigo: number | null; salida: string }>((resolver) => {
        const proceso = spawn(process.execPath, ['--import', 'tsx', 'src/db/optimizarFotos.ts', ...args], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DB_HOST: prueba.host,
            DB_PORT: String(prueba.port),
            DB_USER: prueba.user,
            DB_PASSWORD: prueba.password,
            DB_NAME: ctx.pool.options.database,
            JWT_SECRET: SECRETO_PRUEBAS,
            RECUPERACION_SECRET: SECRETO_RECUPERACION_PRUEBAS,
            TOTP_SECRET: SECRETO_TOTP_PRUEBAS,
            CARPETA_SUBIDAS: subidas,
            NODE_ENV: 'development',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let salida = '';
        const limite = setTimeout(() => proceso.kill(), 60_000);
        proceso.stdout.on('data', (d) => (salida += d));
        proceso.stderr.on('data', (d) => (salida += d));
        proceso.on('close', (codigo) => {
          clearTimeout(limite);
          resolver({ codigo, salida });
        });
        proceso.stdin.end(entrada);
      });
    const actividad = async () =>
      (await consulta(`SELECT superadmin_correo, accion, detalle FROM actividad_superadmin WHERE accion = 'cmd_optimizar_fotos'`));

    test('muestra cuántas hay y, sin un sí, no cambia nada ni deja registro', async () => {
      const antigua = await fotoAntigua('barberos', 'barb_a', await imagen(2000, 2500, 'jpeg'), 'jpg');
      for (const entrada of ['', 'n\n', 'quizás\n']) {
        const r = await ejecutar([`--respaldo=${respaldo}`], entrada);
        assert.equal(r.codigo, 0, r.salida);
        assert.match(r.salida, /por convertir: 1/);
        assert.match(r.salida, /¿Convertir 1 foto\(s\)/);
        assert.match(r.salida, /Cancelado: no se cambió nada/);
      }
      assert.equal(await rutaDe('barberos', 'barb_a'), antigua.ruta);
      assert.equal(existsSync(respaldo), false);
      assert.deepEqual(await actividad(), []);
    });

    test('con un sí convierte, dice cuántas convirtió y lo anota; la segunda vez no hay nada que hacer', async () => {
      await fotoAntigua('barberos', 'barb_a', await imagen(2000, 2500, 'jpeg'), 'jpg');
      await fotoAntigua('empresas', 'emp_a', await imagen(3000, 2000, 'png'), 'png');
      const r = await ejecutar([`--respaldo=${respaldo}`], 's\n');
      assert.equal(r.codigo, 0, r.salida);
      assert.match(r.salida, /✔ Convertidas: 2 de 2/);
      assert.match(r.salida, /Copia de las originales:/);
      const [registro] = await actividad();
      assert.equal(registro.superadmin_correo, 'comando:fotos:optimizar');
      assert.equal(registro.detalle.convertidas, 2);

      const otra = await ejecutar([`--respaldo=${respaldo}`], 's\n');
      assert.equal(otra.codigo, 0, otra.salida);
      assert.match(otra.salida, /ya optimizadas: 2/);
      assert.match(otra.salida, /No hay fotos por convertir/);
      assert.doesNotMatch(otra.salida, /¿Convertir/);
      assert.equal((await actividad()).length, 1);
    });

    test('rechaza argumentos desconocidos y una copia dentro de la carpeta de fotos', async () => {
      const desconocido = await ejecutar(['--ya'], '');
      assert.equal(desconocido.codigo, 1);
      assert.match(desconocido.salida, /Uso: npm run fotos:optimizar/);
      const adentro = await ejecutar([`--respaldo=${join(subidas, 'copia')}`], 's\n');
      assert.equal(adentro.codigo, 1);
      assert.match(adentro.salida, /no puede estar dentro de la carpeta de fotos/);
    });

    test('no se ejecuta solo: solo lo llama su propio script de npm', () => {
      const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
      const quienes = Object.entries(scripts).filter(([, comando]) => comando.includes('optimizarFotos'));
      assert.deepEqual(quienes, [['fotos:optimizar', 'tsx src/db/optimizarFotos.ts']]);
    });
  });
});
