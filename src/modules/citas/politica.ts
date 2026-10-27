// Política de cancelación y reprogramación: el cliente debe avisar con una anticipación mínima
// (empresas.anticipacion_cancelacion_horas, de 0 a 48). El negocio siempre puede cancelar.

export const ANTICIPACION_MAXIMA_HORAS = 48;
export const ANTICIPACION_POR_DEFECTO_HORAS = 3;

export const textoHoras = (horas: number) => (horas === 1 ? '1 hora' : `${horas} horas`);

export const mensajeFueraDePlazo = (accion: 'cancelar' | 'reprogramar', horas: number) =>
  `Solo puedes ${accion} con al menos ${textoHoras(horas)} de anticipación. Esta cita empieza dentro de menos tiempo: comunícate con el negocio.`;
