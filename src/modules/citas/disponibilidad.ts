// Cálculo de las horas en que un profesional puede recibir una cita. Funciones puras:
// trabajan con minutos desde la medianoche, sin base de datos ni Express.

// Cada cuántos minutos puede agendar un cliente (se elige por negocio)
export const INTERVALOS_MINUTOS = [10, 20, 30, 40, 50, 60];

// Un tramo de tiempo [inicio, fin) en minutos desde la medianoche
export type Tramo = { inicio: number; fin: number };

export type HoraDisponible = {
  inicio: number;
  // Queda pegada a la cita, bloqueo, apertura o cierre de al lado: no deja huecos (recomendada)
  pegada: boolean;
};

// Lo libre del horario del negocio una vez quitadas las citas y los bloqueos
export const huecosLibres = (apertura: number, cierre: number, ocupados: Tramo[]): Tramo[] => {
  const huecos: Tramo[] = [];
  let desde = apertura;
  for (const t of [...ocupados].sort((a, b) => a.inicio - b.inicio)) {
    if (t.inicio > desde) huecos.push({ inicio: desde, fin: Math.min(t.inicio, cierre) });
    desde = Math.max(desde, t.fin);
    if (desde >= cierre) break;
  }
  if (desde < cierre) huecos.push({ inicio: desde, fin: cierre });
  return huecos.filter((h) => h.fin > h.inicio);
};

type Entrada = {
  apertura: number;
  cierre: number;
  // Citas (no canceladas) y bloqueos del profesional ese día
  ocupados: Tramo[];
  // Duración del servicio elegido
  duracion: number;
  intervalo: number;
  // El servicio más corto que ofrece el negocio: un hueco menor no se podría vender
  servicioMasCorto: number;
  // No ofrecer horas anteriores a esta (para hoy: el momento actual)
  desde?: number;
  // false (panel del negocio): no se ocultan las horas que dejarían un hueco corto; las pegadas siguen marcadas
  ocultarHuecosCortos?: boolean;
};

// 1. Siempre se ofrecen las horas "pegadas" (si el servicio cabe completo): el inicio de
//    cada espacio libre (apertura o fin de una cita o bloqueo) y la hora en que el
//    servicio termina justo cuando empieza lo siguiente (otra cita, un bloqueo o el cierre).
// 2. En el resto del espacio libre se ofrecen las horas del intervalo, salvo las que
//    dejarían, antes o después del servicio, un hueco menor que el servicio más corto
//    (salvo en el panel del negocio, que las muestra todas).
export const calcularHoras = (e: Entrada): HoraDisponible[] => {
  const horas = new Map<number, boolean>();
  const agregar = (inicio: number, pegada: boolean) => horas.set(inicio, (horas.get(inicio) ?? false) || pegada);

  for (const { inicio: desde, fin: hasta } of huecosLibres(e.apertura, e.cierre, e.ocupados)) {
    const ultimo = hasta - e.duracion; // la última hora en que el servicio todavía cabe
    if (ultimo < desde) continue;
    agregar(desde, true);
    agregar(ultimo, true);
    const primeraDelIntervalo = Math.ceil(desde / e.intervalo) * e.intervalo;
    for (let inicio = primeraDelIntervalo; inicio <= ultimo; inicio += e.intervalo) {
      const huecoAntes = inicio - desde;
      const huecoDespues = ultimo - inicio;
      const ocultar = e.ocultarHuecosCortos ?? true;
      const sirveAntes = !ocultar || huecoAntes === 0 || huecoAntes >= e.servicioMasCorto;
      const sirveDespues = !ocultar || huecoDespues === 0 || huecoDespues >= e.servicioMasCorto;
      if (sirveAntes && sirveDespues) agregar(inicio, false);
    }
  }

  return [...horas]
    .filter(([inicio]) => inicio >= (e.desde ?? 0))
    .sort(([a], [b]) => a - b)
    .map(([inicio, pegada]) => ({ inicio, pegada }));
};
