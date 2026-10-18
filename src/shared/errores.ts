// Errores esperados del negocio. El manejador central los convierte en la
// respuesta { error: mensaje } con su código HTTP; cualquier otro error es un 500.
export class ErrorApp extends Error {
  constructor(
    readonly estado: number,
    mensaje: string,
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
  prohibido: (mensaje: string) => new ErrorApp(403, mensaje),
  noEncontrado: (mensaje: string) => new ErrorApp(404, mensaje),
  conflicto: (mensaje: string) => new ErrorApp(409, mensaje),
};
