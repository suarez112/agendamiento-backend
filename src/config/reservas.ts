// Reglas de las reservas que el dueño de la plataforma puede ajustar.

// Máximo de citas pendientes (confirmadas y que aún no terminan) que un mismo teléfono puede tener en un negocio,
// sea invitado o cliente con cuenta. Frena las reservas falsas que llenan la agenda (hallazgo A-2). Se puede
// cambiar con la variable de entorno MAX_CITAS_PENDIENTES.
export const MAX_CITAS_PENDIENTES_POR_TELEFONO = 3;

export const mensajeTopeCitasPendientes = (tope: number) =>
  `Ya tienes ${tope} citas pendientes en este negocio. Cancela una o espera a que se complete para reservar otra.`;
