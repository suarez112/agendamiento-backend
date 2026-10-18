// Registro estructurado (una línea JSON por evento) para poder filtrarlo y
// enviarlo a cualquier herramienta de monitoreo. Nunca registrar contraseñas,
// tokens ni datos personales de clientes.

type Nivel = 'info' | 'warn' | 'error';

const escribir = (nivel: Nivel, evento: string, datos: Record<string, unknown> = {}) => {
  if (process.env.NODE_ENV === 'test' && nivel !== 'error') return;
  const linea = JSON.stringify({ nivel, evento, fecha: new Date().toISOString(), ...datos });
  if (nivel === 'error') console.error(linea);
  else console.log(linea);
};

export const registro = {
  info: (evento: string, datos?: Record<string, unknown>) => escribir('info', evento, datos),
  warn: (evento: string, datos?: Record<string, unknown>) => escribir('warn', evento, datos),
  error: (evento: string, datos?: Record<string, unknown>) => escribir('error', evento, datos),
};
