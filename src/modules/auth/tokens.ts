import jwt, { type SignOptions } from 'jsonwebtoken';

// Hay dos clases de token:
// - personal (barberos): identifica al barbero y su negocio.
// - cuenta (tabla usuarios: admin de empresa o cliente): lleva tipo 'cuenta'.
// Los permisos (es_admin, rol, empresa) se leen de la base en cada solicitud,
// así un cambio de rol aplica de inmediato.
export type DatosToken = { barberoId: string; empresaId: string };
export type DatosTokenCuenta = { usuarioId: string };

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

    firmarCuenta: ({ usuarioId }: DatosTokenCuenta): string =>
      jwt.sign({ tipo: TIPO_CUENTA }, secreto, opciones(usuarioId)),

    // null si el token no es de una cuenta válida
    verificarCuenta: (token: string): DatosTokenCuenta | null => {
      const datos = leer(token);
      if (!datos || datos.tipo !== TIPO_CUENTA || typeof datos.sub !== 'string') return null;
      return { usuarioId: datos.sub };
    },
  };
};

export type ServicioTokens = ReturnType<typeof crearServicioTokens>;
