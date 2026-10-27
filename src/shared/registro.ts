// Registro estructurado (una línea JSON por evento) para poder filtrarlo y
// enviarlo a cualquier herramienta de monitoreo. Nunca registrar contraseñas,
// tokens ni datos personales de clientes.

type Nivel = 'info' | 'warn' | 'error';

// Los mensajes de error de PostgreSQL suelen repetir el valor que causó el fallo
// (ej. «la sintaxis de entrada no es válida para tipo date: "<lo que escribió la persona>"»). Antes de guardarlos
// en el registro se reemplaza todo lo que va entre comillas, y se recortan.
export const limpiarTexto = (texto: string, maximo = 400): string =>
  texto.replace(/"[^"\n]*"|'[^'\n]*'|«[^»\n]*»|“[^”\n]*”/g, '"…"').slice(0, maximo);

// Los campos de texto libre de un error (mensaje y pila) pasan siempre por limpiarTexto
const CAMPOS_DE_ERROR = new Set(['mensaje', 'pila']);
const limpiarDatos = (datos: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(datos).map(([clave, valor]) => [
      clave,
      CAMPOS_DE_ERROR.has(clave) && typeof valor === 'string' ? limpiarTexto(valor, clave === 'pila' ? 2000 : 400) : valor,
    ]),
  );

// De un error de PostgreSQL solo se guardan datos estructurales: nunca `detail`, que trae los valores de la fila
export const datosDeErrorPg = (error: unknown): Record<string, string> => {
  const e = error as { code?: unknown; severity?: unknown; table?: unknown; column?: unknown; constraint?: unknown } | null;
  if (!e || typeof e.code !== 'string' || typeof e.severity !== 'string') return {};
  return Object.fromEntries(
    Object.entries({ codigoPg: e.code, tabla: e.table, columna: e.column, restriccion: e.constraint }).filter(
      (par): par is [string, string] => typeof par[1] === 'string',
    ),
  );
};

const escribir = (nivel: Nivel, evento: string, datos: Record<string, unknown> = {}) => {
  if (process.env.NODE_ENV === 'test' && nivel !== 'error') return;
  const linea = JSON.stringify({ nivel, evento, fecha: new Date().toISOString(), ...limpiarDatos(datos) });
  if (nivel === 'error') console.error(linea);
  else console.log(linea);
};

export const registro = {
  info: (evento: string, datos?: Record<string, unknown>) => escribir('info', evento, datos),
  warn: (evento: string, datos?: Record<string, unknown>) => escribir('warn', evento, datos),
  error: (evento: string, datos?: Record<string, unknown>) => escribir('error', evento, datos),
};
