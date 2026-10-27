import dotenv from 'dotenv';
import { cargarEntornoBaseDeDatos } from '../config/entorno.js';
import { cifrarContrasenasPendientes } from './cifradoDeContrasenas.js';
import { registrarComando } from './comandos.js';
import { crearPool } from './pool.js';

// npm run db:cifrar-contrasenas
// Reemplaza por bcrypt las contraseñas que aún están en texto plano. Desde M-3 el
// inicio de sesión ya no las acepta: quien siga con una no puede entrar hasta que
// se cifre aquí (o se le cambie la contraseña).
// No se puede deshacer: haz un respaldo de la base antes de ejecutarlo. Queda anotado en la actividad del superadmin.
dotenv.config({ quiet: true });
const pool = crearPool(cargarEntornoBaseDeDatos());

try {
  const { cifradas, vacias } = await cifrarContrasenasPendientes(pool);
  if (cifradas > 0) {
    await registrarComando(pool, { comando: 'db:cifrar-contrasenas', accion: 'cifrar_contrasenas', detalle: { cifradas } });
  }
  console.log(`${cifradas} contraseña(s) cifrada(s)`);
  if (vacias > 0) {
    console.error(`⚠ ${vacias} cuenta(s) con la contraseña vacía: no se cifraron; cámbiales la contraseña.`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
