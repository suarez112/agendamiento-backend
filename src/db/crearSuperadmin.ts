import { randomInt } from 'node:crypto';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import { z } from 'zod';
import { cargarEntorno } from '../config/entorno.js';
import { cifrarContrasena } from '../modules/auth/contrasenas.js';
import * as repositorio from '../modules/superadmin/superadmin.repositorio.js';
import { cifrarSecreto, generarSecretoTotp, urlOtpauth } from '../modules/superadmin/totp.js';
import { CODIGO_PG, crearPool, esErrorPg } from './pool.js';

// npm run dev:crear-superadmin -- correo [--reiniciar]
// Crea la cuenta del dueño de la plataforma. Es la ÚNICA forma de crear un superadmin: no hay registro
// ni endpoint para eso. El comando genera una contraseña al azar y la clave de la verificación en dos
// pasos, y muestra las dos una sola vez (la clave también como código QR para Google Authenticator).
// Con --reiniciar, a un superadmin que ya existe le cambia la contraseña y el segundo paso, y cierra sus sesiones.
dotenv.config({ quiet: true });

const USO = 'Uso: npm run dev:crear-superadmin -- correo [--reiniciar]';
const argumentos = process.argv.slice(2);
const reiniciar = argumentos.includes('--reiniciar');
const correos = argumentos.filter((a) => a !== '--reiniciar');
const correo = z.email().max(254).safeParse(correos[0]?.trim().toLowerCase());

if (correos.length !== 1 || !correo.success || argumentos.length - correos.length > 1) {
  console.error(USO);
  process.exit(1);
}

// Sin letras que se confunden entre sí (0/O, 1/l/I)
const CARACTERES = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const generarContrasena = (largo = 20) => Array.from({ length: largo }, () => CARACTERES[randomInt(CARACTERES.length)]).join('');

const entorno = cargarEntorno();
const pool = crearPool(entorno);

try {
  const contrasena = generarContrasena();
  const secreto = generarSecretoTotp();
  const datos = { passwordHash: await cifrarContrasena(contrasena), totpSecreto: cifrarSecreto(secreto, entorno.JWT_SECRET) };

  if (reiniciar) {
    if (!(await repositorio.reiniciarSuperadmin(pool, correo.data, datos))) {
      console.error(`✖ No existe un superadmin con el correo ${correo.data}. Créalo sin --reiniciar.`);
      process.exit(1);
    }
  } else {
    await repositorio.insertarSuperadmin(pool, { correo: correo.data, ...datos });
  }

  console.log(`✔ Superadmin ${reiniciar ? 'reiniciado' : 'creado'}: ${correo.data}\n`);
  console.log('1) Configura la verificación en dos pasos en Google Authenticator (o Authy, Microsoft Authenticator…).');
  console.log('   Escanea este código QR:\n');
  console.log(await QRCode.toString(urlOtpauth(correo.data, secreto), { type: 'terminal', small: true }));
  console.log(`   ¿No puedes escanearlo? Agrega la cuenta a mano con esta clave: ${secreto.match(/.{1,4}/g)!.join(' ')}`);
  console.log('   (tipo de clave: basada en tiempo, 6 dígitos, 30 segundos)\n');
  console.log(`2) Contraseña: ${contrasena}`);
  console.log('\nGuárdalas ahora: no se vuelven a mostrar. Inicia sesión en POST /api/v1/superadmin/login con');
  console.log('{ "correo", "clave", "codigo" }, donde "codigo" es el número de 6 dígitos que muestra tu app.');
} catch (error) {
  if (esErrorPg(error, CODIGO_PG.violacionUnica)) {
    console.error(`✖ Ya existe un superadmin con el correo ${correo.data}. Para cambiar su contraseña y su segundo paso usa --reiniciar.`);
  } else {
    console.error((error as Error).message);
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
