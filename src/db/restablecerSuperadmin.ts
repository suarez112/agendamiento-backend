import dotenv from 'dotenv';
import { z } from 'zod';
import { cargarEntorno } from '../config/entorno.js';
import { cifrarContrasena } from '../modules/auth/contrasenas.js';
import * as repositorio from '../modules/superadmin/superadmin.repositorio.js';
import { cifrarSecreto, generarSecretoTotp } from '../modules/superadmin/totp.js';
import { generarContrasena, mostrarSegundoPaso } from './credencialesSuperadmin.js';
import { negarEnProduccion, registrarComandoSinFallar } from './comandos.js';
import { crearPool } from './pool.js';

// npm run dev:restablecer-superadmin -- correo [--totp]
// Para cuando olvidaste tu contraseña: genera una nueva (se muestra una sola vez) y cierra las sesiones
// abiertas. Con --totp también genera una clave nueva de la verificación en dos pasos (por ejemplo si
// perdiste el celular): se muestra como QR y escrita, y el QR se guarda como imagen PNG en una carpeta
// que no se sube a GitHub. No hay recuperación por correo para el superadmin: solo este comando.
dotenv.config({ quiet: true });
negarEnProduccion('dev:restablecer-superadmin');

const USO = 'Uso: npm run dev:restablecer-superadmin -- correo [--totp]';
const argumentos = process.argv.slice(2);
const conTotp = argumentos.includes('--totp');
const correos = argumentos.filter((a) => a !== '--totp');
const correo = z.email().max(254).safeParse(correos[0]?.trim().toLowerCase());

if (correos.length !== 1 || !correo.success || argumentos.length - correos.length > 1) {
  console.error(USO);
  process.exit(1);
}

const entorno = cargarEntorno();
const pool = crearPool(entorno);

try {
  const contrasena = generarContrasena();
  const secreto = conTotp ? generarSecretoTotp() : undefined;
  const reiniciado = await repositorio.reiniciarSuperadmin(pool, correo.data, {
    passwordHash: await cifrarContrasena(contrasena),
    totpSecreto: secreto && cifrarSecreto(secreto, entorno.TOTP_SECRET),
  });
  if (!reiniciado) {
    console.error(`✖ No existe un superadmin con el correo ${correo.data}.`);
    process.exitCode = 1;
  } else {
    console.log(`✔ Contraseña restablecida: ${correo.data}. Las sesiones abiertas se cerraron.\n`);
    console.log(`Contraseña nueva: ${contrasena}\n`);
    if (secreto) {
      console.log('Verificación en dos pasos nueva (la anterior ya no sirve). Configúrala en tu app autenticadora:');
      await mostrarSegundoPaso(correo.data, secreto);
    } else {
      console.log('La verificación en dos pasos sigue igual (usa la misma cuenta de tu app autenticadora).');
      console.log('Si también la perdiste, repite el comando con --totp.');
    }
    console.log('\nGuárdala ahora: no se vuelve a mostrar.');
    // Después de mostrar la contraseña: si anotarlo falla, no se pierde
    await registrarComandoSinFallar(pool, {
      comando: 'dev:restablecer-superadmin',
      accion: 'restablecer_superadmin',
      detalle: { correo: correo.data, segundoPaso: Boolean(secreto) },
    });
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
