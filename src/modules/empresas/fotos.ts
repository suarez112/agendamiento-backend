import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Request, RequestHandler } from 'express';
import multer from 'multer';
import { ErrorApp, errores } from '../../shared/errores.js';
import { registro } from '../../shared/registro.js';

// Fotos de las empresas: se guardan en <CARPETA_SUBIDAS>/empresas con un nombre
// aleatorio y la base solo guarda su ruta pública (/uploads/empresas/<archivo>).

export const PREFIJO_FOTOS = '/uploads/empresas';
export const MAX_BYTES_FOTO = 5 * 1024 * 1024;

const MENSAJE_TIPO = 'La foto debe ser una imagen JPG, PNG o WEBP';
const MENSAJE_TAMANO = 'La foto no puede pesar más de 5 MB';
const MENSAJE_CAMPO = 'Envía la imagen en el campo "foto" (multipart/form-data)';

const TIPOS_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Igual que la restricción empresas_foto_url_valida de la migración 004
const RUTA_FOTO = /^\/uploads\/empresas\/([a-f0-9-]{36}\.(jpg|png|webp))$/;

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

export const crearAlmacenFotos = (carpetaSubidas: string) => {
  const carpeta = resolve(carpetaSubidas, 'empresas');
  mkdirSync(carpeta, { recursive: true });

  return {
    carpeta,

    // Guarda la imagen y devuelve su ruta pública. Rechaza lo que no sea JPG/PNG/WEBP.
    async guardar(datos: Buffer): Promise<string> {
      const extension = extensionPorContenido(datos);
      if (!extension) throw errores.solicitudInvalida(MENSAJE_TIPO);
      const archivo = `${randomUUID()}.${extension}`;
      await writeFile(join(carpeta, archivo), datos, { flag: 'wx' });
      return `${PREFIJO_FOTOS}/${archivo}`;
    },

    // Borra una foto anterior. Si falla, solo queda en el log: la foto nueva ya está guardada.
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
