// Dónde corren las pruebas de integración. Nunca usan la base de desarrollo (DB_NAME):
// cada archivo de prueba crea una base temporal y la borra al terminar, y para eso se
// conecta a la base de pruebas indicada en TEST_DB_NAME (ej. agendamiento_test).
// Si falta o apunta a la base de desarrollo, la suite se niega a correr.

export type ConfigPruebas = {
  host: string;
  port: number;
  user: string;
  password: string;
  // Base a la que se conecta la suite para crear y borrar las temporales
  baseMantenimiento: string;
  // Toda base temporal empieza así; solo esas se pueden borrar
  prefijo: string;
};

const BASE_DE_DESARROLLO = 'agendamiento_db';

const PASOS = `
Para preparar la base de pruebas:
  1. Crea una base vacía, por ejemplo:  CREATE DATABASE agendamiento_test;
  2. Agrega esta línea al archivo .env:  TEST_DB_NAME=agendamiento_test
  (Opcional, recomendado: TEST_DB_USER y TEST_DB_PASSWORD con un usuario que solo tenga permiso CREATEDB.)`;

// La suite crea y borra bases, así que no puede usar el usuario limitado de la app (DB_USER):
// toma el primer grupo que tenga usuario (TEST_DB_*, luego DB_MIGRACION_*, luego DB_*) y usa
// la contraseña de ESE mismo grupo, nunca la de otro.
const GRUPOS_DE_CREDENCIALES = [
  ['TEST_DB_USER', 'TEST_DB_PASSWORD'],
  ['DB_MIGRACION_USER', 'DB_MIGRACION_PASSWORD'],
  ['DB_USER', 'DB_PASSWORD'],
] as const;

// Un valor solo con espacios cuenta como no definido (un " " en el .env no es un usuario ni una contraseña).
// El usuario se recorta; la contraseña se usa tal cual, porque los espacios al borde pueden ser parte de ella.
const definido = (valor: string | undefined) => valor !== undefined && valor.trim() !== '';

const leerCredenciales = (env: NodeJS.ProcessEnv) => {
  const grupo = GRUPOS_DE_CREDENCIALES.find(([variableUsuario]) => definido(env[variableUsuario]));
  if (!grupo) throw new Error(`Faltan las credenciales: define TEST_DB_USER (o DB_MIGRACION_USER).${PASOS}`);
  const [variableUsuario, variableClave] = grupo;
  const password = env[variableClave];
  if (!definido(password)) {
    throw new Error(
      `${variableUsuario} está definido pero falta ${variableClave} (o está vacía). ` +
        `Cada usuario va con su propia contraseña: no se toma la de otro grupo.${PASOS}`,
    );
  }
  return { user: (env[variableUsuario] as string).trim(), password: password as string };
};

export const leerConfigPruebas = (env: NodeJS.ProcessEnv = process.env): ConfigPruebas => {
  const nombre = env.TEST_DB_NAME?.trim();
  if (!nombre) {
    throw new Error(`Las pruebas necesitan su propia base de datos y no encontraron TEST_DB_NAME.${PASOS}`);
  }
  if (nombre.toLowerCase() === BASE_DE_DESARROLLO || nombre === env.DB_NAME?.trim()) {
    throw new Error(
      `TEST_DB_NAME apunta a la base de desarrollo ("${nombre}"). Las pruebas no pueden usarla: ` +
        `podrían borrar o cambiar datos reales.${PASOS}`,
    );
  }
  if (!/test|prueba/i.test(nombre)) {
    throw new Error(`TEST_DB_NAME ("${nombre}") debe incluir la palabra "test" o "prueba" para evitar confusiones.${PASOS}`);
  }

  const { user, password } = leerCredenciales(env);

  return {
    host: env.TEST_DB_HOST ?? env.DB_HOST ?? 'localhost',
    port: Number(env.TEST_DB_PORT ?? env.DB_PORT ?? 5432),
    user,
    password,
    baseMantenimiento: nombre,
    prefijo: `${nombre}_`,
  };
};

export const esBaseTemporalDePrueba = (config: ConfigPruebas, nombre: string) =>
  nombre.startsWith(config.prefijo) && nombre.length > config.prefijo.length;
