import bcrypt from 'bcryptjs';
import { createHash, timingSafeEqual } from 'node:crypto';

export const COSTO_BCRYPT = 12;

const esHashBcrypt = (valor: string) => /^\$2[aby]\$\d{2}\$/.test(valor);

export const cifrarContrasena = (clave: string) => bcrypt.hash(clave, COSTO_BCRYPT);

// Compara sin filtrar por el tiempo de respuesta cuántos caracteres coinciden
const igualesEnTiempoConstante = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

// Hash de relleno: si el usuario no existe se hace el mismo trabajo que si
// existiera, para que el tiempo de respuesta no revele qué usuarios hay.
let hashDeRelleno: Promise<string> | undefined;

type Verificacion = { valida: boolean; requiereActualizar: boolean };

export const verificarContrasena = async (
  clave: string,
  almacenada: string | undefined,
): Promise<Verificacion> => {
  if (almacenada === undefined) {
    hashDeRelleno ??= cifrarContrasena('usuario-inexistente');
    await bcrypt.compare(clave, await hashDeRelleno);
    return { valida: false, requiereActualizar: false };
  }

  if (esHashBcrypt(almacenada)) {
    const valida = await bcrypt.compare(clave, almacenada);
    return { valida, requiereActualizar: valida && bcrypt.getRounds(almacenada) < COSTO_BCRYPT };
  }

  // Formato heredado (texto plano): se acepta una vez y se reemplaza por bcrypt
  const valida = igualesEnTiempoConstante(clave, almacenada);
  return { valida, requiereActualizar: valida };
};
