import bcrypt from 'bcryptjs';

export const COSTO_BCRYPT = 12;

const esHashBcrypt = (valor: string) => /^\$2[aby]\$\d{2}\$/.test(valor);

export const cifrarContrasena = (clave: string) => bcrypt.hash(clave, COSTO_BCRYPT);

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

  // Un valor que no es un hash bcrypt (por ejemplo, texto plano) nunca es válido
  if (!esHashBcrypt(almacenada)) {
    hashDeRelleno ??= cifrarContrasena('usuario-inexistente');
    await bcrypt.compare(clave, await hashDeRelleno);
    return { valida: false, requiereActualizar: false };
  }

  const valida = await bcrypt.compare(clave, almacenada);
  return { valida, requiereActualizar: valida && bcrypt.getRounds(almacenada) < COSTO_BCRYPT };
};
