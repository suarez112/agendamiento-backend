// Errores esperados del negocio. El manejador central los convierte en la
// respuesta { error: mensaje } con su código HTTP; cualquier otro error es un 500.
export class ErrorApp extends Error {
  constructor(
    readonly estado: number,
    mensaje: string,
    // Campos extra que se agregan a la respuesta { error } (ej. el código de la función no incluida)
    readonly extra?: Record<string, unknown>,
  ) {
    super(mensaje);
    this.name = 'ErrorApp';
  }
}

export const errores = {
  solicitudInvalida: (mensaje: string) => new ErrorApp(400, mensaje),
  noAutenticado: (mensaje: string) => new ErrorApp(401, mensaje),
  // La empresa debe activar (pagar) su suscripción para continuar
  pagoRequerido: (mensaje: string) => new ErrorApp(402, mensaje),
  prohibido: (mensaje: string, extra?: Record<string, unknown>) => new ErrorApp(403, mensaje, extra),
  noEncontrado: (mensaje: string) => new ErrorApp(404, mensaje),
  conflicto: (mensaje: string) => new ErrorApp(409, mensaje),
  demasiadosIntentos: (mensaje: string) => new ErrorApp(429, mensaje),
  demasiadoGrande: (mensaje: string) => new ErrorApp(413, mensaje),
};
