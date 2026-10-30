import type { ConsultaPago, ProveedorPago, ResultadoPago } from './proveedor.js';

// Proveedor de pagos manuales: la persona paga por Nequi, llave Bre-B o código QR y envía el comprobante por
// WhatsApp; el superadmin verifica el pago y aprueba o rechaza la orden (ver pagos.manual.servicio.ts).
// No hay pasarela a la que preguntar, así que el servicio de pagos reconoce este proveedor por su nombre y nunca
// llama a crearPago ni a consultarPago (no existe una URL de pago ni un estado externo). Se mantiene detrás de la
// misma interfaz para poder volver a una pasarela cambiando solo PROVEEDOR_PAGO.
export const crearProveedorManual = (): ProveedorPago => ({
  nombre: 'manual',
  async crearPago(): Promise<{ url: string }> {
    return { url: '' };
  },
  async consultarPago(_consulta: ConsultaPago): Promise<ResultadoPago | null> {
    return null;
  },
});
