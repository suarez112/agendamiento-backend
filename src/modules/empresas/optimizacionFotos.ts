import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import type { Consultable } from '../../db/pool.js';
import { PREFIJO_SUBIDAS, procesarFoto, rutaFoto, TAMANOS_FOTO, type TipoFoto } from './fotos.js';

// Optimiza las fotos que ya estaban guardadas antes de que las subidas se redujeran al tamaño de pantalla
// (npm run fotos:optimizar). Cada foto pendiente se convierte con el mismo procesamiento de las subidas nuevas
// (procesarFoto), se guarda con un nombre nuevo .webp y la base pasa a apuntar a ella. Antes de tocar nada se copia la
// original a una carpeta de respaldo, fuera de la carpeta pública de fotos.
//
// Se puede correr varias veces: una foto que ya es WebP y cabe en su tamaño no se toca, y una fila que cambió
// mientras tanto (alguien subió otra foto) no se pisa. Nunca se ejecuta sola: solo con el comando.

const TIPOS: TipoFoto[] = ['empresas', 'barberos', 'productos'];

export type EstadoFoto = 'pendiente' | 'ya_optimizada' | 'externa' | 'sin_archivo' | 'ilegible';

export type FotoGuardada = {
  tipo: TipoFoto;
  id: string;
  ruta: string;
  // Nombre del archivo en <carpeta>/<tipo>/ (null si la ruta no es de la carpeta de fotos)
  archivo: string | null;
  estado: EstadoFoto;
  bytes: number;
};

export type Revision = { fotos: FotoGuardada[]; pendientes: FotoGuardada[] };

export type Resumen = {
  convertidas: number;
  // La fila cambió mientras se convertía (otra foto subida): no se tocó
  cambiadas: number;
  // No se pudo leer, copiar o guardar (queda como estaba)
  fallidas: number;
  bytesAntes: number;
  bytesDespues: number;
  carpetaRespaldo: string;
};

// Lista de lo que se cambió, dentro de la carpeta de respaldo: sirve para volver atrás (copiar la original a su carpeta
// y devolver la ruta anterior a esa fila)
export const ARCHIVO_CAMBIOS = 'cambios.csv';

// Nombre de la carpeta de respaldo de esta corrida (una por corrida, así nunca se pisa un respaldo anterior)
export const carpetaRespaldoPorDefecto = (carpetaSubidas: string, ahora = new Date()) =>
  join(`${resolve(carpetaSubidas)}-respaldo`, ahora.toISOString().replace(/[:.]/g, '-'));

// El respaldo no puede quedar dentro de la carpeta de fotos: esa carpeta se publica en /uploads
export const respaldoDentroDeSubidas = (carpetaSubidas: string, carpetaRespaldo: string) => {
  const camino = relative(resolve(carpetaSubidas), resolve(carpetaRespaldo));
  return camino === '' || (!camino.startsWith('..') && !isAbsolute(camino));
};

const estadoDelArchivo = async (tipo: TipoFoto, ruta: string): Promise<Pick<FotoGuardada, 'estado' | 'bytes'>> => {
  let datos: Buffer;
  try {
    datos = await readFile(ruta);
  } catch {
    return { estado: 'sin_archivo', bytes: 0 };
  }
  try {
    const meta = await sharp(datos).metadata();
    const { ancho, alto } = TAMANOS_FOTO[tipo];
    const cabe = (meta.width ?? Infinity) <= ancho && (meta.height ?? Infinity) <= alto;
    return { estado: meta.format === 'webp' && cabe ? 'ya_optimizada' : 'pendiente', bytes: datos.length };
  } catch {
    return { estado: 'ilegible', bytes: datos.length };
  }
};

// Revisa todas las fotos de la base (negocios, equipo y productos) sin cambiar nada
export const revisarFotos = async (db: Consultable, carpetaSubidas: string): Promise<Revision> => {
  const fotos: FotoGuardada[] = [];
  for (const tipo of TIPOS) {
    const filas = (await db.query<{ id: string; foto_url: string }>(
      `SELECT id, foto_url FROM ${tipo} WHERE foto_url IS NOT NULL ORDER BY id`,
    )).rows;
    for (const { id, foto_url: ruta } of filas) {
      const archivo = rutaFoto(tipo).exec(ruta)?.[1] ?? null;
      // Direcciones web antiguas del equipo u otras rutas: no son archivos nuestros
      if (!archivo) {
        fotos.push({ tipo, id, ruta, archivo, estado: 'externa', bytes: 0 });
        continue;
      }
      fotos.push({ tipo, id, ruta, archivo, ...(await estadoDelArchivo(tipo, join(resolve(carpetaSubidas), tipo, archivo))) });
    }
  }
  return { fotos, pendientes: fotos.filter((f) => f.estado === 'pendiente') };
};

const anotarCambio = async (respaldo: string, columnas: string[]) => {
  const archivo = join(respaldo, ARCHIVO_CAMBIOS);
  // El encabezado solo la primera vez ('wx' falla si ya existe)
  await writeFile(archivo, 'tabla,id,ruta_anterior,ruta_nueva\n', { flag: 'wx' }).catch(() => undefined);
  await appendFile(archivo, `${columnas.join(',')}\n`);
};

// Convierte las fotos pendientes. Por cada una: 1) copia la original al respaldo, 2) guarda la versión WebP con un
// nombre nuevo, 3) cambia la ruta en la base solo si la fila sigue apuntando a la original y 4) borra la original de la
// carpeta pública. Si algo falla en una foto, esa foto queda como estaba y se sigue con las demás.
export const convertirFotos = async (
  db: Consultable,
  pendientes: FotoGuardada[],
  opciones: { carpetaSubidas: string; carpetaRespaldo: string },
): Promise<Resumen> => {
  const subidas = resolve(opciones.carpetaSubidas);
  const respaldo = resolve(opciones.carpetaRespaldo);
  if (respaldoDentroDeSubidas(subidas, respaldo)) {
    throw new Error(`La carpeta de respaldo no puede estar dentro de la carpeta de fotos (${subidas}): se publicaría en ${PREFIJO_SUBIDAS}`);
  }
  const resumen: Resumen = { convertidas: 0, cambiadas: 0, fallidas: 0, bytesAntes: 0, bytesDespues: 0, carpetaRespaldo: respaldo };

  for (const foto of pendientes) {
    if (!foto.archivo) continue;
    const original = join(subidas, foto.tipo, foto.archivo);
    const copia = join(respaldo, foto.tipo, foto.archivo);
    const nombreNuevo = `${randomUUID()}.webp`;
    const nueva = join(subidas, foto.tipo, nombreNuevo);
    const rutaNueva = `${PREFIJO_SUBIDAS}/${foto.tipo}/${nombreNuevo}`;
    let nuevaEscrita = false;
    try {
      const datos = await readFile(original);
      // 1. Copia de la original antes de tocarla (COPYFILE_EXCL: nunca pisa una copia que ya exista)
      await mkdir(dirname(copia), { recursive: true });
      await copyFile(original, copia, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      // 2. Versión reducida en WebP, con el mismo procesamiento de las subidas nuevas
      const procesada = await procesarFoto(datos, foto.tipo);
      await writeFile(nueva, procesada, { flag: 'wx' });
      nuevaEscrita = true;
      // 3. La base pasa a la foto nueva solo si nadie la cambió mientras tanto
      const cambio = await db.query(`UPDATE ${foto.tipo} SET foto_url = $1 WHERE id = $2 AND foto_url = $3`, [
        rutaNueva,
        foto.id,
        foto.ruta,
      ]);
      if (!cambio.rowCount) {
        await unlink(nueva);
        resumen.cambiadas++;
        continue;
      }
      // Desde aquí la base apunta a la foto nueva: un error posterior nunca debe borrarla
      nuevaEscrita = false;
      await anotarCambio(respaldo, [foto.tipo, foto.id, foto.ruta, rutaNueva]);
      resumen.convertidas++;
      resumen.bytesAntes += datos.length;
      resumen.bytesDespues += procesada.length;
      // 4. La original ya tiene copia: se quita de la carpeta pública (si falla, solo ocupa espacio)
      await unlink(original).catch(() => undefined);
    } catch {
      if (nuevaEscrita) await unlink(nueva).catch(() => undefined);
      resumen.fallidas++;
    }
  }
  return resumen;
};
