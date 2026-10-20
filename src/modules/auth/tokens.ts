import jwt, { type SignOptions } from 'jsonwebtoken';

// Hay dos clases de token:
// - personal (barberos): identifica al barbero y su negocio.
// - cuenta (tabla usuarios: admin de empresa o cliente): lleva tipo 'cuenta'.
// Los permisos (es_admin, rol, empresa) se leen de la base en cada solicitud,
// así un cambio de rol aplica de inmediato.
export type DatosToken = { barberoId: string; empresaId: string };
// version = usuarios.version_sesion al firmar; si la cuenta cambia su contraseña,
// la versión sube y los tokens anteriores dejan de servir. Los tokens de antes
// de la migración 013 no la traen y cuentan como versión 0.
export type DatosTokenCuenta = { usuarioId: string; version: number };

const ALGORITMO = 'HS256';
const TIPO_CUENTA = 'cuenta';

export const crearServicioTokens = (secreto: string, expiraEn: string) => {
  const opciones = (subject: string): SignOptions => ({
    algorithm: ALGORITMO,
    subject,
    expiresIn: expiraEn as NonNullable<SignOptions['expiresIn']>,
  });

  // Contenido del token si la firma es válida y no venció; null en otro caso
  const leer = (token: string): Record<string, unknown> | null => {
    try {
      const datos = jwt.verify(token, secreto, { algorithms: [ALGORITMO] });
      return typeof datos === 'string' ? null : (datos as Record<string, unknown>);
    } catch {
      return null;
    }
  };

  return {
    firmar: ({ barberoId, empresaId }: DatosToken): string =>
      jwt.sign({ empresaId }, secreto, opciones(barberoId)),

    // null si el token es falso, venció, es de una cuenta o no tiene el formato esperado
    verificar: (token: string): DatosToken | null => {
      const datos = leer(token);
      if (!datos || datos.tipo !== undefined) return null;
      const { sub, empresaId } = datos;
      if (typeof sub !== 'string' || typeof empresaId !== 'string') return null;
      return { barberoId: sub, empresaId };
    },

    firmarCuenta: ({ usuarioId, version }: DatosTokenCuenta): string =>
      jwt.sign({ tipo: TIPO_CUENTA, ver: version }, secreto, opciones(usuarioId)),

    // null si el token no es de una cuenta válida
    verificarCuenta: (token: string): DatosTokenCuenta | null => {
      const datos = leer(token);
      if (!datos || datos.tipo !== TIPO_CUENTA || typeof datos.sub !== 'string') return null;
      const version = datos.ver ?? 0;
      if (typeof version !== 'number' || !Number.isInteger(version)) return null;
      return { usuarioId: datos.sub, version };
    },
  };
};

export type ServicioTokens = ReturnType<typeof crearServicioTokens>;
