// Tiempo disponible de un profesional: horario del negocio menos sus bloqueos. Funciones puras:
// trabajan con minutos desde la medianoche y fechas AAAA-MM-DD, sin base de datos ni Express.

export type Tramo = { inicio: number; fin: number };

export type BloqueoProfesional = {
  barberoId: string;
  // Semanal: día de la semana (0 = domingo); de una fecha: AAAA-MM-DD
  diaSemana: number | null;
  fecha: string | null;
  inicio: number;
  fin: number;
};

const DIA_MS = 86_400_000;

// Todas las fechas de un rango, ambas incluidas, con su día de la semana (0 = domingo)
export const diasDelRango = (desde: string, hasta: string) => {
  const dias: { fecha: string; diaSemana: number }[] = [];
  for (let t = Date.parse(desde); t <= Date.parse(hasta); t += DIA_MS) {
    const d = new Date(t);
    dias.push({ fecha: d.toISOString().slice(0, 10), diaSemana: d.getUTCDay() });
  }
  return dias;
};

// Minutos de [apertura, cierre) que no están cubiertos por ningún bloqueo (los bloqueos que se
// cruzan entre sí o salen del horario no se cuentan dos veces)
export const minutosLibres = (apertura: number, cierre: number, bloqueos: Tramo[]) => {
  let libres = cierre - apertura;
  let hasta = apertura;
  const recortados = bloqueos
    .map((b) => ({ inicio: Math.max(b.inicio, apertura), fin: Math.min(b.fin, cierre) }))
    .filter((b) => b.fin > b.inicio)
    .sort((a, b) => a.inicio - b.inicio);
  for (const b of recortados) {
    const inicio = Math.max(b.inicio, hasta);
    if (b.fin > inicio) {
      libres -= b.fin - inicio;
      hasta = b.fin;
    }
  }
  return libres;
};

// Minutos que un profesional puede atender en el rango: por cada día, el horario del negocio de ese
// día de la semana menos sus bloqueos semanales de ese día y los de esa fecha
export const minutosDisponibles = (
  dias: { fecha: string; diaSemana: number }[],
  horarios: Map<number, Tramo>,
  bloqueos: BloqueoProfesional[],
) => {
  let total = 0;
  for (const dia of dias) {
    const horario = horarios.get(dia.diaSemana);
    if (!horario) continue;
    const deHoy = bloqueos.filter((b) => (b.fecha === null ? b.diaSemana === dia.diaSemana : b.fecha === dia.fecha));
    total += minutosLibres(horario.inicio, horario.fin, deHoy);
  }
  return total;
};
