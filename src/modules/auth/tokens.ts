import jwt, { type SignOptions } from 'jsonwebtoken';

// Hay dos clases de token:
// - personal (barberos): identifica al barbero y su negocio, y lleva la versión de su sesión.
// - cuenta (tabla usuarios: admin de empresa o cliente): lleva tipo 'cuenta'.
// Los permisos (es_admin, rol, empresa) se leen de la base en cada solicitud,
// así un cambio de rol aplica de inmediato.
// version = barberos.version_sesion / usuarios.version_sesion al firmar; si cambia la contraseña o se cierra
// la sesión en el servidor (POST /logout), la versión sube y los tokens anteriores dejan de servir. Los tokens
// de antes de las migraciones 013 (cuentas) y 029 (personal) no la traen y cuentan como versión 0.
export type DatosToken = { barberoId: string; empresaId: string; version: number };
export type DatosTokenCuenta = { usuarioId: string; version: number };

const ALGORITMO = 'HS256';
const TIPO_CUENTA = 'cuenta';
const TIPO_SUPERADMIN = 'superadmin';
// La sesión del superadmin es corta y no depende de JWT_EXPIRA_EN
const DURACION_SUPERADMIN = '1h';

export const crearServicioTokens = (secreto: string, expiraEn: string) => {
  const opciones = (subject: string, duracion = expiraEn): SignOptions => ({
    algorithm: ALGORITMO,
    subject,
    expiresIn: duracion as NonNullable<SignOptions['expiresIn']>,
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
    firmar: ({ barberoId, empresaId, version }: DatosToken): string =>
      jwt.sign({ empresaId, ver: version }, secreto, opciones(barberoId)),

    // null si el token es falso, venció, es de una cuenta o no tiene el formato esperado
    verificar: (token: string): DatosToken | null => {
      const datos = leer(token);
      if (!datos || datos.tipo !== undefined) return null;
      const { sub, empresaId } = datos;
      if (typeof sub !== 'string' || typeof empresaId !== 'string') return null;
      const version = datos.ver ?? 0;
      if (typeof version !== 'number' || !Number.isInteger(version)) return null;
      return { barberoId: sub, empresaId, version };
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

    // Token del superadmin (tabla superadmins): ninguna otra guardia lo acepta. Dura 1 hora.
    firmarSuperadmin: ({ superadminId, version }: { superadminId: string; version: number }): string =>
      jwt.sign({ tipo: TIPO_SUPERADMIN, ver: version }, secreto, opciones(superadminId, DURACION_SUPERADMIN)),

    verificarSuperadmin: (token: string): { superadminId: string; version: number } | null => {
      const datos = leer(token);
      if (!datos || datos.tipo !== TIPO_SUPERADMIN || typeof datos.sub !== 'string') return null;
      if (typeof datos.ver !== 'number' || !Number.isInteger(datos.ver)) return null;
      return { superadminId: datos.sub, version: datos.ver };
    },
  };
};

export type ServicioTokens = ReturnType<typeof crearServicioTokens>;
