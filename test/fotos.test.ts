import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { TAMANOS_FOTO } from '../src/modules/empresas/fotos.js';
import { type Contexto, iniciar, iniciarSesion, pedir } from './apoyo/servidor.js';

// Fotos del equipo y del negocio: se reducen al tamaño con que la app las muestra (con margen para pantallas
// nítidas), se guardan en WebP sin metadatos, se valida el tipo y el peso, y las fotos antiguas siguen sirviendo
describe('fotos del equipo y del negocio', () => {
  let ctx: Contexto;
  let carpeta: string;
  let token: string;
  const consulta = async (sql: string, valores: unknown[] = []) => (await ctx.pool.query(sql, valores)).rows;

  before(async () => {
    carpeta = mkdtempSync(join(tmpdir(), 'fotos-prueba-'));
    ctx = await iniciar({ entorno: { CARPETA_SUBIDAS: carpeta } });
    token = await iniciarSesion(ctx, 'admin.a', '1234');
  });
  after(async () => {
    await ctx.cerrar();
    rmSync(carpeta, { recursive: true, force: true });
  });

  const imagen = (ancho: number, alto: number, formato: 'jpeg' | 'png' | 'webp' | 'gif' = 'jpeg') =>
    sharp({ create: { width: ancho, height: alto, channels: 3, background: '#2e86de' } })
      [formato]()
      .toBuffer();

  const subir = async (ruta: string, datos: Buffer, tipo = 'image/jpeg', nombre = 'foto.jpg') => {
    const cuerpo = new FormData();
    cuerpo.append('foto', new Blob([new Uint8Array(datos)], { type: tipo }), nombre);
    const r = await fetch(`${ctx.url}${ruta}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: cuerpo });
    return { estado: r.status, json: await r.json() };
  };
  const archivoDe = (ruta: string) => join(carpeta, ruta.replace('/uploads/', ''));
  const fotoDe = async (tabla: 'barberos' | 'empresas', id: string) =>
    (await consulta(`SELECT foto_url FROM ${tabla} WHERE id = $1`, [id]))[0].foto_url as string;
  const archivosEn = (tipo: string) => {
    try {
      return readdirSync(join(carpeta, tipo)).sort();
    } catch {
      return [];
    }
  };

  test('la foto de un integrante se reduce a su tamaño en pantalla (4:5) y queda en WebP sin metadatos', async () => {
    // Foto de celular grande, con EXIF (incluye datos que no deben quedar)
    const original = await sharp({ create: { width: 3000, height: 3750, channels: 3, background: '#2e86de' } })
      .withExif({ IFD0: { Copyright: 'dato-privado' } })
      .jpeg()
      .toBuffer();
    const r = await subir('/api/v1/equipo/barb_a/foto', original);
    assert.equal(r.estado, 200, JSON.stringify(r.json));
    assert.equal(r.json.mensaje, 'Foto del profesional actualizada');

    const ruta = await fotoDe('barberos', 'barb_a');
    assert.match(ruta, /^\/uploads\/barberos\/[a-f0-9-]{36}\.webp$/);
    assert.ok(r.json.foto.endsWith(ruta));
    const meta = await sharp(readFileSync(archivoDe(ruta))).metadata();
    assert.equal(meta.format, 'webp');
    assert.deepEqual([meta.width, meta.height], [TAMANOS_FOTO.barberos.ancho, TAMANOS_FOTO.barberos.alto]);
    assert.equal(meta.exif, undefined);
  });

  test('la foto del negocio se reduce a su tamaño en pantalla y conserva la proporción', async () => {
    const r = await subir('/api/v1/admin/empresa/foto', await imagen(4000, 3000, 'png'), 'image/png', 'negocio.png');
    assert.equal(r.estado, 200, JSON.stringify(r.json));
    const ruta = await fotoDe('empresas', 'emp_a');
    assert.match(ruta, /^\/uploads\/empresas\/[a-f0-9-]{36}\.webp$/);
    const meta = await sharp(readFileSync(archivoDe(ruta))).metadata();
    assert.equal(meta.format, 'webp');
    assert.deepEqual([meta.width, meta.height], [TAMANOS_FOTO.empresas.ancho, TAMANOS_FOTO.empresas.alto]);
  });

  test('una foto más pequeña que el tamaño en pantalla no se agranda', async () => {
    const r = await subir('/api/v1/equipo/barb_a/foto', await imagen(200, 250, 'webp'), 'image/webp', 'p.webp');
    assert.equal(r.estado, 200, JSON.stringify(r.json));
    const meta = await sharp(readFileSync(archivoDe(await fotoDe('barberos', 'barb_a')))).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 200, 250]);
  });

  test('se rechaza lo que no es JPG, PNG o WEBP real y lo que pesa más de 5 MB, sin guardar nada', async () => {
    const antes = { barberos: archivosEn('barberos'), empresas: archivosEn('empresas') };
    const fotoAntes = await fotoDe('barberos', 'barb_a');
    const tipo = { error: 'La foto debe ser una imagen JPG, PNG o WEBP' };

    // Texto con nombre y tipo de imagen: se decide por el contenido
    assert.deepEqual(await subir('/api/v1/equipo/barb_a/foto', Buffer.from('no soy una imagen'), 'image/jpeg', 'falsa.jpg'), { estado: 400, json: tipo });
    // GIF real: formato no permitido
    assert.deepEqual(await subir('/api/v1/equipo/barb_a/foto', await imagen(10, 10, 'gif'), 'image/gif', 'a.gif'), { estado: 400, json: tipo });
    // Firma de JPEG pero el resto dañado
    const danada = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
    assert.deepEqual(await subir('/api/v1/admin/empresa/foto', danada, 'image/jpeg', 'rota.jpg'), { estado: 400, json: tipo });
    // Más de 5 MB
    const pesada = Buffer.concat([await imagen(10, 10), Buffer.alloc(5 * 1024 * 1024)]);
    assert.deepEqual(await subir('/api/v1/equipo/barb_a/foto', pesada), { estado: 413, json: { error: 'La foto no puede pesar más de 5 MB' } });

    assert.deepEqual({ barberos: archivosEn('barberos'), empresas: archivosEn('empresas') }, antes);
    assert.equal(await fotoDe('barberos', 'barb_a'), fotoAntes);
  });

  test('las fotos subidas antes (JPG y PNG sin convertir) siguen funcionando', async () => {
    const jpg = `${randomUUID()}.jpg`;
    const png = `${randomUUID()}.png`;
    mkdirSync(join(carpeta, 'barberos'), { recursive: true });
    mkdirSync(join(carpeta, 'empresas'), { recursive: true });
    writeFileSync(join(carpeta, 'barberos', jpg), await imagen(1500, 1500));
    writeFileSync(join(carpeta, 'empresas', png), await imagen(1500, 1000, 'png'));
    await consulta(`UPDATE barberos SET foto_url = $1 WHERE id = 'barb_a2'`, [`/uploads/barberos/${jpg}`]);
    await consulta(`UPDATE empresas SET foto_url = $1 WHERE id = 'emp_b'`, [`/uploads/empresas/${png}`]);

    const equipo = await pedir(ctx, '/api/v1/equipo', { token });
    const fotoA2 = equipo.json.find((b: { id: string }) => b.id === 'barb_a2').foto as string;
    assert.ok(fotoA2.endsWith(`/uploads/barberos/${jpg}`), fotoA2);
    const perfil = await pedir(ctx, '/api/v1/empresas/perfil/NEGB');
    assert.ok(perfil.json.fotoUrl.endsWith(`/uploads/empresas/${png}`), perfil.json.fotoUrl);

    for (const [url, formato] of [[fotoA2, 'jpeg'], [perfil.json.fotoUrl, 'png']] as const) {
      const r = await fetch(url);
      assert.equal(r.status, 200, url);
      assert.equal((await sharp(Buffer.from(await r.arrayBuffer())).metadata()).format, formato);
    }
  });
});
