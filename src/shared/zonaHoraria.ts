// Zona horaria de cada negocio (nombre IANA, ej. America/Bogota).
// En la base todo instante es timestamptz (UTC); la zona solo se usa para saber qué día y qué hora
// es en el negocio y para escribir las fechas con su desfase (ISO 8601).

export const ZONA_POR_DEFECTO = 'America/Bogota';

const formateadores = new Map<string, Intl.DateTimeFormat>();

// Intl lanza RangeError si la zona no existe
const formateador = (zona: string) => {
  let f = formateadores.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: zona,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formateadores.set(zona, f);
  }
  return f;
};

export const esZonaValida = (zona: unknown): zona is string => {
  if (typeof zona !== 'string' || zona.length === 0 || zona.length > 64) return false;
  try {
    formateador(zona);
    return true;
  } catch {
    return false;
  }
};

// Nombre oficial de la zona ("america/bogota" → "America/Bogota")
export const zonaCanonica = (zona: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zona }).resolvedOptions().timeZone;

const partes = (instante: Date, zona: string) => {
  const p: Record<string, string> = {};
  for (const { type, value } of formateador(zona).formatToParts(instante)) p[type] = value;
  return p;
};

// Fecha de hoy en esa zona (AAAA-MM-DD)
export const hoyEn = (zona: string, ahora = new Date()) => {
  const p = partes(ahora, zona);
  return `${p.year}-${p.month}-${p.day}`;
};

// Minutos transcurridos desde la medianoche, en esa zona
export const minutosAhoraEn = (zona: string, ahora = new Date()) => {
  const p = partes(ahora, zona);
  return Number(p.hour) * 60 + Number(p.minute);
};

// Suma días a una fecha AAAA-MM-DD (calendario puro, sin zona)
export const sumarDiasAFecha = (fecha: string, dias: number) => {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

// Desfase de la zona en ese instante, en minutos (Bogotá = -300)
const desfaseMinutos = (instante: Date, zona: string) => {
  const p = partes(instante, zona);
  const comoUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((comoUtc - Math.floor(instante.getTime() / 1000) * 1000) / 60_000);
};

// ISO 8601 con el desfase de la zona: 2026-10-22T09:30:00.000-05:00
export const aIsoEnZona = (instante: Date | string | null | undefined, zona: string): string | null => {
  if (instante === null || instante === undefined) return null;
  const fecha = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(fecha.getTime())) return null;
  const p = partes(fecha, zona);
  const desfase = desfaseMinutos(fecha, zona);
  const signo = desfase < 0 ? '-' : '+';
  const abs = Math.abs(desfase);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const ms = String(fecha.getUTCMilliseconds()).padStart(3, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${ms}${signo}${hh}:${mm}`;
};

// Instante UTC (ISO) de una fecha y hora de pared del negocio. Útil para comparar con now().
export const instanteDePared = (fecha: string, hhmm: string, zona: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  const aprox = Date.UTC(+fecha.slice(0, 4), +fecha.slice(5, 7) - 1, +fecha.slice(8, 10), h, m);
  let t = aprox - desfaseMinutos(new Date(aprox), zona) * 60_000;
  t = aprox - desfaseMinutos(new Date(t), zona) * 60_000;
  return new Date(t);
};
