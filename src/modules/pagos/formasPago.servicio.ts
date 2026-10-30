import type pg from 'pg';
import sharp from 'sharp';
import { enTransaccion } from '../../db/pool.js';
import { ErrorApp, errores } from '../../shared/errores.js';
import { aIsoEnZona } from '../../shared/zonaHoraria.js';
import { ZONA_PLATAFORMA } from '../../config/plataforma.js';
import { extensionPorContenido } from '../empresas/fotos.js';
import { registrarActividad } from '../superadmin/superadmin.repositorio.js';
import type { SesionSuperadmin } from '../superadmin/superadmin.servicio.js';

// Formas de pago manuales (Nequi, llave Bre-B y código QR). Las configura solo el superadmin; las lee un
// administrador de negocio con sesión y solo las activas. Nada de esto es público.

export const MAX_BYTES_QR = 1024 * 1024;
export const TIPOS_QR = ['nequi', 'breb'] as const;
export type TipoQr = (typeof TIPOS_QR)[number];

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;
// Tope de píxeles al decodificar: una imagen pequeña en bytes puede ser enorme al abrirla
const MAX_PIXELES_QR = 25_000_000;

const MENSAJE_QR_INVALIDO = 'El código QR debe ser una imagen JPG, PNG o WEBP';
export const MENSAJE_SIN_CONFIGURAR = 'Las formas de pago todavía no están configuradas. Comunícate con soporte para activar tu plan.';
const MENSAJE_NINGUNA = 'Debe haber al menos una forma de pago activa (Nequi, llave Bre-B o código QR)';

type FilaFormas = {
  titular: string;
  whatsapp: string;
  nequi_numero: string | null;
  nequi_activo: boolean;
  llave_breb: string | null;
  llave_breb_activa: boolean;
  qr_activo: boolean;
  tiene_qr_nequi: boolean;
  tiene_qr_breb: boolean;
  actualizado_por_correo: string;
  actualizado_en: Date;
};

const COLUMNAS = `titular, whatsapp, nequi_numero, nequi_activo, llave_breb, llave_breb_activa, qr_activo,
  qr_nequi IS NOT NULL AS tiene_qr_nequi, qr_breb IS NOT NULL AS tiene_qr_breb, actualizado_por_correo, actualizado_en`;

const enlaceWhatsapp = (telefono: string) => `https://wa.me/${telefono.replace(/^\+/, '')}`;

// Lo que se guarda tras un cambio. Los campos con undefined conservan su valor actual.
export type CambioFormas = {
  titular?: string;
  whatsapp?: string;
  nequiNumero?: string | null;
  llaveBreb?: string | null;
  nequiActivo?: boolean;
  llaveBrebActiva?: boolean;
  qrActivo?: boolean;
};

const rutaQr = (tipo: TipoQr) => `/api/v1/pagos/formas-pago/qr/${tipo}`;

export const crearServicioFormasPago = ({ pool }: { pool: pg.Pool }) => {
  const leer = async (db: pg.Pool | pg.PoolClient, bloquear = false) =>
    (await db.query<FilaFormas>(`SELECT ${COLUMNAS} FROM formas_pago_manual WHERE id${bloquear ? ' FOR UPDATE' : ''}`)).rows[0];

  // Cada forma activa debe tener sus datos y debe haber al menos una activa. Se valida el resultado completo.
  const validar = (f: FilaFormas) => {
    if (!f.nequi_activo && !f.llave_breb_activa && !f.qr_activo) throw errores.conflicto(MENSAJE_NINGUNA);
    if (f.nequi_activo && !f.nequi_numero) throw errores.solicitudInvalida('Para activar Nequi indica el número en "nequiNumero"');
    if (f.llave_breb_activa && !f.llave_breb) throw errores.solicitudInvalida('Para activar la llave Bre-B indica la llave en "llaveBreb"');
    if (f.qr_activo && !f.tiene_qr_nequi && !f.tiene_qr_breb) {
      throw errores.solicitudInvalida('Para activar el código QR sube primero al menos una imagen');
    }
  };

  const armarSuperadmin = (f: FilaFormas) => ({
    configurada: true as const,
    titular: f.titular,
    whatsapp: f.whatsapp,
    whatsappUrl: enlaceWhatsapp(f.whatsapp),
    nequi: { numero: f.nequi_numero, activo: f.nequi_activo },
    llaveBreb: { llave: f.llave_breb, activa: f.llave_breb_activa },
    qr: { activo: f.qr_activo, nequi: f.tiene_qr_nequi, breb: f.tiene_qr_breb },
    actualizadoPor: f.actualizado_por_correo,
    actualizadoEn: aIsoEnZona(f.actualizado_en, ZONA_PLATAFORMA),
    zonaHoraria: ZONA_PLATAFORMA,
  });

  // Lo que ve el administrador de un negocio: solo lo activo y solo lo que sirve para pagar
  const armarActivas = (f: FilaFormas, urlBase: string) => ({
    titular: f.titular,
    whatsapp: f.whatsapp,
    whatsappUrl: enlaceWhatsapp(f.whatsapp),
    formas: [
      ...(f.nequi_activo && f.nequi_numero ? [{ tipo: 'nequi' as const, numero: f.nequi_numero }] : []),
      ...(f.llave_breb_activa && f.llave_breb ? [{ tipo: 'llave_breb' as const, llave: f.llave_breb }] : []),
      ...(f.qr_activo
        ? [
            {
              tipo: 'qr' as const,
              imagenes: [
                ...(f.tiene_qr_nequi ? [{ tipo: 'nequi' as const, url: `${urlBase}${rutaQr('nequi')}` }] : []),
                ...(f.tiene_qr_breb ? [{ tipo: 'breb' as const, url: `${urlBase}${rutaQr('breb')}` }] : []),
              ],
            },
          ]
        : []),
    ],
  });

  const registrar = (tx: pg.PoolClient, admin: SesionSuperadmin, accion: string, detalle: Record<string, unknown>) =>
    registrarActividad(tx, { superadminId: admin.id, superadminCorreo: admin.correo, accion, referencia: 'formas_pago_manual', detalle });

  return {
    // Superadmin: todo, con quién lo cambió y cuándo
    async ver() {
      const f = await leer(pool);
      return f ? armarSuperadmin(f) : { configurada: false as const };
    },

    // Administrador de un negocio: solo lo activo. null = todavía no hay nada configurado.
    async activas(urlBase: string) {
      const f = await leer(pool);
      return f ? armarActivas(f, urlBase) : null;
    },

    async activasObligatorias(urlBase: string, db: pg.Pool | pg.PoolClient = pool) {
      const f = await leer(db);
      if (!f) throw new ErrorApp(503, MENSAJE_SIN_CONFIGURAR);
      return armarActivas(f, urlBase);
    },

    // Superadmin: cambia los datos o activa/desactiva formas. Parcial: lo que no llega se conserva.
    async guardar(admin: SesionSuperadmin, cambio: CambioFormas) {
      return enTransaccion(pool, async (tx) => {
        const actual = await leer(tx, true);
        if (!actual && (cambio.titular === undefined || cambio.whatsapp === undefined)) {
          throw errores.solicitudInvalida('Para configurar las formas de pago por primera vez indica "titular" y "whatsapp"');
        }
        const base: FilaFormas = actual ?? {
          titular: '',
          whatsapp: '',
          nequi_numero: null,
          nequi_activo: false,
          llave_breb: null,
          llave_breb_activa: false,
          qr_activo: false,
          tiene_qr_nequi: false,
          tiene_qr_breb: false,
          actualizado_por_correo: admin.correo,
          actualizado_en: new Date(),
        };
        const siguiente: FilaFormas = {
          ...base,
          titular: cambio.titular ?? base.titular,
          whatsapp: cambio.whatsapp ?? base.whatsapp,
          nequi_numero: cambio.nequiNumero === undefined ? base.nequi_numero : cambio.nequiNumero,
          llave_breb: cambio.llaveBreb === undefined ? base.llave_breb : cambio.llaveBreb,
          nequi_activo: cambio.nequiActivo ?? base.nequi_activo,
          llave_breb_activa: cambio.llaveBrebActiva ?? base.llave_breb_activa,
          qr_activo: cambio.qrActivo ?? base.qr_activo,
        };
        validar(siguiente);
        const valores = [
          siguiente.titular,
          siguiente.whatsapp,
          siguiente.nequi_numero,
          siguiente.nequi_activo,
          siguiente.llave_breb,
          siguiente.llave_breb_activa,
          siguiente.qr_activo,
          admin.id,
          admin.correo,
        ];
        // INSERT solo la primera vez: las restricciones de la tabla se evalúan sobre la fila propuesta, así que un
        // INSERT ... ON CONFLICT no sirve para actualizar (no vería los QR que ya están guardados)
        await tx.query(
          actual
            ? `UPDATE formas_pago_manual
               SET titular = $1, whatsapp = $2, nequi_numero = $3, nequi_activo = $4, llave_breb = $5, llave_breb_activa = $6,
                   qr_activo = $7, actualizado_por_id = $8, actualizado_por_correo = $9, actualizado_en = now()
               WHERE id`
            : `INSERT INTO formas_pago_manual
                 (titular, whatsapp, nequi_numero, nequi_activo, llave_breb, llave_breb_activa, qr_activo, actualizado_por_id, actualizado_por_correo)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          valores,
        );
        // Solo los nombres de los campos que cambiaron: el registro de actividad no guarda los datos de pago
        await registrar(tx, admin, 'actualizar_formas_pago', {
          campos: Object.entries(cambio)
            .filter(([, v]) => v !== undefined)
            .map(([k]) => k),
        });
        return { mensaje: 'Formas de pago actualizadas', formasPago: armarSuperadmin((await leer(tx))!) };
      });
    },

    // Superadmin: sube o reemplaza una imagen de QR. Se valida el contenido real del archivo, no su nombre.
    async guardarQr(admin: SesionSuperadmin, tipo: TipoQr, datos: Buffer) {
      if (datos.length === 0 || datos.length > MAX_BYTES_QR) {
        throw datos.length === 0 ? errores.solicitudInvalida(MENSAJE_QR_INVALIDO) : errores.demasiadoGrande('El código QR no puede pesar más de 1 MB');
      }
      const extension = extensionPorContenido(datos);
      if (!extension) throw errores.solicitudInvalida(MENSAJE_QR_INVALIDO);
      try {
        // Decodifica la imagen completa: una firma de imagen con basura detrás no pasa
        await sharp(datos, { limitInputPixels: MAX_PIXELES_QR, failOn: 'error' }).raw().toBuffer();
      } catch {
        throw errores.solicitudInvalida(MENSAJE_QR_INVALIDO);
      }
      const columnas = tipo === 'nequi' ? ['qr_nequi', 'qr_nequi_tipo'] : ['qr_breb', 'qr_breb_tipo'];
      return enTransaccion(pool, async (tx) => {
        if (!(await leer(tx, true))) throw errores.conflicto('Primero guarda los datos de pago (titular y WhatsApp) y luego sube los códigos QR');
        await tx.query(
          `UPDATE formas_pago_manual SET ${columnas[0]} = $1, ${columnas[1]} = $2,
             actualizado_por_id = $3, actualizado_por_correo = $4, actualizado_en = now() WHERE id`,
          [datos, MIME[extension], admin.id, admin.correo],
        );
        await registrar(tx, admin, 'actualizar_qr_pago', { qr: tipo, tipo: MIME[extension], bytes: datos.length });
        return { mensaje: 'Código QR actualizado', formasPago: armarSuperadmin((await leer(tx))!) };
      });
    },

    async borrarQr(admin: SesionSuperadmin, tipo: TipoQr) {
      const columnas = tipo === 'nequi' ? ['qr_nequi', 'qr_nequi_tipo'] : ['qr_breb', 'qr_breb_tipo'];
      return enTransaccion(pool, async (tx) => {
        const actual = await leer(tx, true);
        if (!actual) throw errores.noEncontrado('Todavía no hay formas de pago configuradas');
        const quedaraAlgunQr = tipo === 'nequi' ? actual.tiene_qr_breb : actual.tiene_qr_nequi;
        if (actual.qr_activo && !quedaraAlgunQr) {
          throw errores.conflicto('Es el único código QR y la forma de pago "código QR" está activa: desactívala o sube otro antes de borrarlo');
        }
        await tx.query(
          `UPDATE formas_pago_manual SET ${columnas[0]} = NULL, ${columnas[1]} = NULL,
             actualizado_por_id = $1, actualizado_por_correo = $2, actualizado_en = now() WHERE id`,
          [admin.id, admin.correo],
        );
        await registrar(tx, admin, 'borrar_qr_pago', { qr: tipo });
        return { mensaje: 'Código QR eliminado', formasPago: armarSuperadmin((await leer(tx))!) };
      });
    },

    // Imagen de un QR. `soloActivo`: el administrador de un negocio solo la ve si la forma de pago "QR" está activa.
    async imagenQr(tipo: TipoQr, soloActivo: boolean) {
      const columnas = tipo === 'nequi' ? ['qr_nequi', 'qr_nequi_tipo'] : ['qr_breb', 'qr_breb_tipo'];
      const f = (
        await pool.query<{ imagen: Buffer | null; tipo: string | null; qr_activo: boolean }>(
          `SELECT ${columnas[0]} AS imagen, ${columnas[1]} AS tipo, qr_activo FROM formas_pago_manual WHERE id`,
        )
      ).rows[0];
      if (!f?.imagen || !f.tipo || (soloActivo && !f.qr_activo)) throw errores.noEncontrado('Código QR no encontrado');
      return { imagen: f.imagen, tipo: f.tipo };
    },
  };
};

export type ServicioFormasPago = ReturnType<typeof crearServicioFormasPago>;
