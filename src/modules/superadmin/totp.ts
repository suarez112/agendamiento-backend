import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

// Verificación en dos pasos (TOTP, RFC 6238): la misma que usan Google Authenticator, Authy y similares.
// Códigos de 6 dígitos que cambian cada 30 segundos (HMAC-SHA1).
const PASO_SEGUNDOS = 30;
const DIGITOS = 6;
// Se acepta el código del paso anterior y del siguiente, por si el reloj del celular se atrasa o se adelanta un poco
const VENTANA = 1;
const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const EMISOR = 'Agendamiento';

const aBase32 = (bytes: Buffer) => {
  let bits = 0;
  let valor = 0;
  let salida = '';
  for (const byte of bytes) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO_BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) salida += ALFABETO_BASE32[(valor << (5 - bits)) & 31];
  return salida;
};

const deBase32 = (texto: string) => {
  let bits = 0;
  let valor = 0;
  const bytes: number[] = [];
  for (const letra of texto.replace(/[\s=]/g, '').toUpperCase()) {
    const indice = ALFABETO_BASE32.indexOf(letra);
    if (indice < 0) throw new Error('Clave TOTP inválida');
    valor = (valor << 5) | indice;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

// Clave nueva de 160 bits en base32 (la que se escribe o se escanea en la app autenticadora)
export const generarSecretoTotp = () => aBase32(randomBytes(20));

export const pasoActual = (ahoraMs = Date.now()) => Math.floor(ahoraMs / 1000 / PASO_SEGUNDOS);

const codigoDelPaso = (secreto: string, paso: number) => {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(paso));
  const hmac = createHmac('sha1', deBase32(secreto)).update(contador).digest();
  const desplazamiento = hmac[hmac.length - 1] & 15;
  const numero = hmac.readUInt32BE(desplazamiento) & 0x7fffffff;
  return String(numero % 10 ** DIGITOS).padStart(DIGITOS, '0');
};

export const codigoTotp = (secreto: string, ahoraMs = Date.now()) => codigoDelPaso(secreto, pasoActual(ahoraMs));

// Paso (ventana de 30 s) al que corresponde el código, o null si no es válido. Quien llama guarda ese
// paso y rechaza cualquier código de un paso igual o anterior, para que un código no se use dos veces.
export const verificarTotp = (secreto: string, codigo: string, ahoraMs = Date.now()): number | null => {
  if (!/^\d{6}$/.test(codigo)) return null;
  const actual = pasoActual(ahoraMs);
  const recibido = Buffer.from(codigo);
  let encontrado: number | null = null;
  // Se revisan todos los pasos de la ventana, sin cortar al primero, para no filtrar nada por el tiempo
  for (let paso = actual - VENTANA; paso <= actual + VENTANA; paso++) {
    if (timingSafeEqual(Buffer.from(codigoDelPaso(secreto, paso)), recibido)) encontrado = paso;
  }
  return encontrado;
};

// Enlace que leen las apps autenticadoras (es lo que lleva el código QR)
export const urlOtpauth = (correo: string, secreto: string) =>
  `otpauth://totp/${encodeURIComponent(`${EMISOR}:${correo}`)}?secret=${secreto}&issuer=${encodeURIComponent(EMISOR)}` +
  `&algorithm=SHA1&digits=${DIGITOS}&period=${PASO_SEGUNDOS}`;

// La clave TOTP debe poder leerse de nuevo, así que no se puede guardar con un hash: se cifra (AES-256-GCM)
// con una llave derivada de TOTP_SECRET (un secreto propio, distinto del de las sesiones). Si TOTP_SECRET cambia,
// hay que volver a cifrar las claves con npm run db:recifrar-2fa (o reiniciar el segundo paso con
// npm run dev:crear-superadmin -- correo --reiniciar).
const llave = (jwtSecret: string) => Buffer.from(hkdfSync('sha256', jwtSecret, '', 'superadmin-totp', 32));

export const cifrarSecreto = (secreto: string, jwtSecret: string) => {
  const iv = randomBytes(12);
  const cifrador = createCipheriv('aes-256-gcm', llave(jwtSecret), iv);
  const cifrado = Buffer.concat([cifrador.update(secreto, 'utf8'), cifrador.final()]);
  return [iv, cifrador.getAuthTag(), cifrado].map((b) => b.toString('base64')).join('.');
};

// null si el texto no se puede descifrar (llave distinta o dato alterado)
export const descifrarSecreto = (guardado: string, jwtSecret: string): string | null => {
  try {
    const [iv, etiqueta, cifrado] = guardado.split('.').map((p) => Buffer.from(p, 'base64'));
    const descifrador = createDecipheriv('aes-256-gcm', llave(jwtSecret), iv);
    descifrador.setAuthTag(etiqueta);
    return Buffer.concat([descifrador.update(cifrado), descifrador.final()]).toString('utf8');
  } catch {
    return null;
  }
};
