import { randomInt } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { urlOtpauth } from '../modules/superadmin/totp.js';

// Carpeta de los códigos QR del segundo paso. Está en .gitignore: nunca se sube a GitHub.
export const CARPETA_SECRETOS = 'secretos-superadmin';

// Sin letras que se confunden entre sí (0/O, 1/l/I)
const CARACTERES = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const ESPECIALES = '!#$%&*+-=?@_';
// Siempre cumple la regla de contraseñas: mayúscula, minúscula, número y carácter especial
export const generarContrasena = (largo = 20) => {
  const elegir = (conjunto: string) => conjunto[randomInt(conjunto.length)];
  const letras = Array.from({ length: largo - 4 }, () => elegir(CARACTERES));
  const obligatorios = [elegir('ABCDEFGHJKLMNPQRSTUVWXYZ'), elegir('abcdefghijkmnopqrstuvwxyz'), elegir('23456789'), elegir(ESPECIALES)];
  const todos = [...letras, ...obligatorios];
  for (let i = todos.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [todos[i], todos[j]] = [todos[j], todos[i]];
  }
  return todos.join('');
};

// Muestra la clave del segundo paso (QR en la terminal y también escrita) y guarda el QR como PNG.
// Devuelve la ruta del archivo.
export const mostrarSegundoPaso = async (correo: string, secreto: string) => {
  const url = urlOtpauth(correo, secreto);
  console.log('   Escanea este código QR:\n');
  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  console.log(`   ¿No puedes escanearlo? Agrega la cuenta a mano con esta clave: ${secreto.match(/.{1,4}/g)!.join(' ')}`);
  console.log('   (tipo de clave: basada en tiempo, 6 dígitos, 30 segundos)\n');

  await mkdir(CARPETA_SECRETOS, { recursive: true });
  const archivo = path.join(CARPETA_SECRETOS, `totp-${correo.replace(/[^a-z0-9._-]/gi, '_')}.png`);
  await QRCode.toFile(archivo, url, { type: 'png', width: 400 });
  // En Windows chmod casi no tiene efecto; en Linux y macOS deja el archivo solo para ti
  await chmod(archivo, 0o600).catch(() => undefined);
  console.log(`   El QR también quedó guardado como imagen: ${archivo}`);
  console.log('   (esa carpeta no se sube a GitHub; borra la imagen cuando ya hayas configurado la app)');
  return archivo;
};
