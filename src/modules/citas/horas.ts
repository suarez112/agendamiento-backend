// Conversión de horas y fechas. Funciones puras: sin base de datos ni Express.

const HORA_12 = /^(0?[1-9]|1[0-2]):([0-5]\d) (AM|PM)$/;
const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

// "09:40 AM" -> 580 (minutos desde la medianoche); null si el formato no es válido
export const hora12AMinutos = (hora: string): number | null => {
  const partes = HORA_12.exec(hora);
  if (!partes) return null;
  let h = Number(partes[1]) % 12;
  if (partes[3] === 'PM') h += 12;
  return h * 60 + Number(partes[2]);
};

// "08:00:00" (formato de PostgreSQL) -> 480
export const hora24AMinutos = (hora: string): number => {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
};

// 580 -> "09:40" (formato que entiende la base de datos)
export const minutosAHHMM = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

// "2026-02-31" tiene el formato correcto pero no existe en el calendario.
// El año 0000 no existe en PostgreSQL.
export const esFechaReal = (fecha: string): boolean => {
  if (!FECHA_ISO.test(fecha) || Number(fecha.slice(0, 4)) < 1) return false;
  const dia = new Date(`${fecha}T00:00:00Z`);
  return !Number.isNaN(dia.getTime()) && dia.toISOString().slice(0, 10) === fecha;
};

// 580 -> "09:40 AM" (el formato con que la app reserva y muestra las horas)
export const minutosAHora12 = (total: number): string => {
  const h24 = Math.floor(total / 60) % 24;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${String(h).padStart(2, '0')}:${String(total % 60).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
};
