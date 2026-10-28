// Interfaz de proveedor de pago. El resto del backend solo conoce esto: cambiar de pasarela es escribir otra
// implementación (hoy: "simulado" para desarrollo y "wompi" para producción).

export type NombreProveedor = 'simulado' | 'wompi';
export type EstadoPago = 'pendiente' | 'aprobada' | 'rechazada' | 'anulada';

export type OrdenParaPago = {
  referencia: string;
  montoCentavos: number;
  moneda: 'COP';
  // Dirección a la que la pasarela devuelve a la persona después de pagar
  urlRegreso: string;
};

// Lo que dice la pasarela de un pago. El servicio compara referencia, monto y moneda con la orden antes de confiar.
export type ResultadoPago = {
  estado: EstadoPago;
  referencia: string;
  montoCentavos: number;
  moneda: string;
  idExterno: string | null;
};

export type ConsultaPago = { referencia: string; idExterno?: string | null };

// Datos que se aprovechan de un evento firmado: solo para saber QUÉ orden consultar. El estado y el monto
// nunca se toman del evento: siempre se vuelven a pedir a la pasarela.
export type EventoDePago = { referencia: string; idExterno: string | null };

export interface ProveedorPago {
  readonly nombre: NombreProveedor;
  // Dirección donde la persona paga (con la firma de integridad, si la pasarela la pide)
  crearPago(orden: OrdenParaPago): Promise<{ url: string }>;
  // Estado actual del pago según la pasarela; null si la pasarela no conoce ese pago
  consultarPago(consulta: ConsultaPago): Promise<ResultadoPago | null>;
  // Solo las pasarelas que avisan por webhook. null = firma inválida o evento que no importa
  verificarEvento?(cuerpo: unknown): Promise<EventoDePago | null>;
}
