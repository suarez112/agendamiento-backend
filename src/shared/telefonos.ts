import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';

// Teléfonos en formato E.164 (ej. +573162781393), con la librería libphonenumber-js
// (metadatos completos, para validar los rangos reales de cada país).

export const TELEFONO_INVALIDO =
  'El número de teléfono no es válido. Revisa el número y el indicativo del país (ej. 3001234567 para Colombia).';

// Indicativo que se asume cuando el número no trae el código de país
export const INDICATIVO_COLOMBIA = '57';

export type TelefonoNormalizado = { telefono: string; indicativo: string };

// Convierte lo que escribió la persona a E.164. Si empieza con "+" se usa su propio
// código de país; si no, el indicativo recibido (Colombia por defecto). También
// acepta el número con el indicativo pegado (ej. "573001234567"). null = inválido.
export const normalizarTelefono = (
  telefono: string,
  indicativo: string = INDICATIVO_COLOMBIA,
): TelefonoNormalizado | null => {
  const texto = telefono.trim();
  const digitos = texto.replace(/\D/g, '');
  if (!digitos || digitos.length > 15) return null;

  const candidatos = texto.startsWith('+')
    ? [`+${digitos}`]
    : [`+${indicativo}${digitos}`, ...(digitos.startsWith(indicativo) ? [`+${digitos}`] : [])];

  for (const candidato of candidatos) {
    const numero = parsePhoneNumberFromString(candidato);
    if (numero?.isValid()) return { telefono: numero.number, indicativo: numero.countryCallingCode };
  }
  return null;
};

// Para esquemas con "telefono" (texto) e "indicativo" (opcional): deja el teléfono en
// E.164 y el indicativo que corresponde a ese número, o responde 400 si no es válido.
export const conTelefonoNormalizado = <T extends { telefono?: string; indicativo?: string }>(
  datos: T,
  ctx: z.RefinementCtx,
): T => {
  if (datos.telefono === undefined) return datos;
  const normalizado = normalizarTelefono(datos.telefono, datos.indicativo);
  if (!normalizado) {
    ctx.addIssue({ code: 'custom', message: TELEFONO_INVALIDO, path: ['telefono'] });
    return z.NEVER;
  }
  return { ...datos, ...normalizado };
};

// Un teléfono ya guardado en E.164 (los que no se pudieron convertir no empiezan con "+")
export const esE164 = (telefono: string | null | undefined): telefono is string =>
  !!telefono && /^\+[1-9]\d{6,14}$/.test(telefono);
