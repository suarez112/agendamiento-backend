import jwt, { type SignOptions } from 'jsonwebtoken';

// El token solo identifica al barbero y su negocio. Los permisos (es_admin) se
// leen de la base en cada solicitud, así un cambio de rol aplica de inmediato.
export type DatosToken = { barberoId: string; empresaId: string };

const ALGORITMO = 'HS256';

export const crearServicioTokens = (secreto: string, expiraEn: string) => ({
  firmar: ({ barberoId, empresaId }: DatosToken): string =>
    jwt.sign({ empresaId }, secreto, {
      algorithm: ALGORITMO,
      subject: barberoId,
      expiresIn: expiraEn as NonNullable<SignOptions['expiresIn']>,
    }),

  // null si el token es falso, venció o no tiene el formato esperado
  verificar: (token: string): DatosToken | null => {
    try {
      const datos = jwt.verify(token, secreto, { algorithms: [ALGORITMO] });
      if (typeof datos === 'string') return null;
      const { sub, empresaId } = datos as { sub?: unknown; empresaId?: unknown };
      if (typeof sub !== 'string' || typeof empresaId !== 'string') return null;
      return { barberoId: sub, empresaId };
    } catch {
      return null;
    }
  },
});

export type ServicioTokens = ReturnType<typeof crearServicioTokens>;
