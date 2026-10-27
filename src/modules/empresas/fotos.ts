import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Request, RequestHandler } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { ErrorApp, errores } from '../../shared/errores.js';
import { registro } from '../../shared/registro.js';

// Fotos subidas (empresas, equipo y productos): se guardan en
// <CARPETA_SUBIDAS>/<tipo> con un nombre aleatorio y la base solo guarda su ruta
// pública (/uploads/<tipo>/<archivo>). Toda foto nueva se valida como imagen real, se reduce a 1080 px
// de lado como máximo, se convierte a WebP y pierde sus metadatos (EXIF, incluida la ubicación GPS).
// Las fotos que ya estaban guardadas no se tocan.

export const PREFIJO_SUBIDAS = '/uploads';
export const MAX_BYTES_FOTO = 5 * 1024 * 1024;
export const MAX_LADO_FOTO = 1080;
// Tope de píxeles al decodificar: una imagen pequeña en bytes puede ser enorme al abrirla
const MAX_PIXELES = 40_000_000;

export type TipoFoto = 'empresas' | 'barberos' | 'productos';

const MENSAJE_TIPO = 'La foto debe ser una imagen JPG, PNG o WEBP';
const MENSAJE_TAMANO = 'La foto no puede pesar más de 5 MB';
const MENSAJE_CAMPO = 'Envía la imagen en el campo "foto" (multipart/form-data)';

const TIPOS_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Para empresas, igual que la restricción empresas_foto_url_valida de la migración 004
const rutaFoto = (tipo: TipoFoto) => new RegExp(`^${PREFIJO_SUBIDAS}/${tipo}/([a-f0-9-]{36}\\.(jpg|png|webp))$`);

type Extension = 'jpg' | 'png' | 'webp';

// El tipo real se decide por los primeros bytes del archivo, no por el nombre ni
// por el Content-Type que manda el cliente (ambos se pueden falsificar).
const extensionPorContenido = (datos: Buffer): Extension | undefined => {
  if (datos.length >= 3 && datos[0] === 0xff && datos[1] === 0xd8 && datos[2] === 0xff) return 'jpg';
  if (datos.length >= 8 && datos.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (
    datos.length >= 12 &&
    datos.toString('ascii', 0, 4) === 'RIFF' &&
    datos.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return undefined;
};

export const crearAlmacenFotos = (carpetaSubidas: string, tipo: TipoFoto) => {
  const carpeta = resolve(carpetaSubidas, tipo);
  mkdirSync(carpeta, { recursive: true });
  const prefijo = `${PREFIJO_SUBIDAS}/${tipo}`;
  const RUTA_FOTO = rutaFoto(tipo);

  return {
    carpeta,

    // Guarda la imagen y devuelve su ruta pública. Rechaza lo que no sea JPG/PNG/WEBP real.
    // Se redimensiona (máximo 1080 px de lado, sin agrandar), se convierte a WebP y se descartan
    // los metadatos: sharp no los copia a la salida. rotate() aplica antes la orientación del EXIF,
    // para que la foto no quede girada al perder ese dato.
    async guardar(datos: Buffer): Promise<string> {
      if (!extensionPorContenido(datos)) throw errores.solicitudInvalida(MENSAJE_TIPO);
      let procesada: Buffer;
      try {
        procesada = await sharp(datos, { limitInputPixels: MAX_PIXELES, failOn: 'error' })
          .rotate()
          .resize(MAX_LADO_FOTO, MAX_LADO_FOTO, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
      } catch {
        // Archivo con la firma de una imagen pero dañado o que no se puede decodificar
        throw errores.solicitudInvalida(MENSAJE_TIPO);
      }
      const archivo = `${randomUUID()}.webp`;
      await writeFile(join(carpeta, archivo), procesada, { flag: 'wx' });
      return `${prefijo}/${archivo}`;
    },

    // Borra una foto anterior. Si falla, solo queda en el log: la foto nueva ya está guardada.
    // Ignora rutas que no sean de esta carpeta (ej. direcciones web antiguas del equipo).
    async borrar(ruta: string | null | undefined) {
      const archivo = ruta ? RUTA_FOTO.exec(ruta)?.[1] : undefined;
      if (!archivo) return;
      try {
        await unlink(join(carpeta, archivo));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        registro.warn('foto_no_borrada', { archivo, mensaje: (error as Error).message });
      }
    },
  };
};

export type AlmacenFotos = ReturnType<typeof crearAlmacenFotos>;

const lector = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES_FOTO, files: 1, fields: 0, parts: 1 },
  fileFilter: (_req, archivo, aceptar) => {
    if (TIPOS_PERMITIDOS.has(archivo.mimetype)) aceptar(null, true);
    else aceptar(errores.solicitudInvalida(MENSAJE_TIPO));
  },
});

const leerUnaFoto = lector.single('foto');

// Lee la foto de una solicitud multipart/form-data (campo "foto") y traduce los
// errores de multer a mensajes para el usuario.
export const recibirFoto: RequestHandler = (req, res, next) => {
  leerUnaFoto(req, res, (error?: unknown) => {
    if (error instanceof multer.MulterError) {
      next(
        error.code === 'LIMIT_FILE_SIZE'
          ? errores.demasiadoGrande(MENSAJE_TAMANO)
          : errores.solicitudInvalida(MENSAJE_CAMPO),
      );
      return;
    }
    // Errores propios (tipo no permitido) pasan tal cual; un cuerpo multipart
    // mal formado se responde como solicitud inválida, no como error del servidor
    if (error) {
      next(error instanceof ErrorApp ? error : errores.solicitudInvalida(MENSAJE_CAMPO));
      return;
    }
    if (!req.file) {
      next(errores.solicitudInvalida(MENSAJE_CAMPO));
      return;
    }
    next();
  });
};

// Dirección base para las URL de las fotos: URL_PUBLICA si está configurada; si no,
// la misma dirección con la que llegó la solicitud (útil en desarrollo).
export const crearUrlBase = (urlPublica: string | undefined) => (req: Request) =>
  urlPublica ?? `${req.protocol}://${req.get('host')}`;

export type UrlBase = ReturnType<typeof crearUrlBase>;

// La base guarda "/uploads/<tipo>/<archivo>"; la app necesita la dirección completa.
// Las fotos antiguas del equipo pueden ser direcciones web completas: se devuelven tal cual.
export const urlFoto = (urlBase: string, ruta: string | null | undefined) => {
  if (!ruta) return null;
  return ruta.startsWith(`${PREFIJO_SUBIDAS}/`) ? `${urlBase}${ruta}` : ruta;
};

// Todas las carpetas de fotos, listas para usar en los servicios
export const crearAlmacenesFotos = (carpetaSubidas: string) => ({
  carpeta: resolve(carpetaSubidas),
  empresas: crearAlmacenFotos(carpetaSubidas, 'empresas'),
  barberos: crearAlmacenFotos(carpetaSubidas, 'barberos'),
  productos: crearAlmacenFotos(carpetaSubidas, 'productos'),
});

export type AlmacenesFotos = ReturnType<typeof crearAlmacenesFotos>;
