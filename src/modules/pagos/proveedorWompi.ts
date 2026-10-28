import { WompiClient } from '@pulgueta/wompi';
import { buildCheckoutUrl, isTransactionUpdatedEvent, verifyWebhookEvent } from '@pulgueta/wompi/server';
import { registro } from '../../shared/registro.js';
import type { ConsultaPago, EstadoPago, EventoDePago, OrdenParaPago, ProveedorPago, ResultadoPago } from './proveedor.js';

export type LlavesWompi = {
  publica: string;
  privada: string;
  // Secreto de eventos (firma de los webhooks) y secreto de integridad (firma del Web Checkout)
  secretoEventos: string;
  secretoIntegridad: string;
};

// Llaves de prueba (sandbox) llevan "test" en su prefijo: pub_test_, prv_test_, test_events_, test_integrity_
export const esLlaveDePrueba = (llave: string) => /^(pub_test_|prv_test_|test_events_|test_integrity_)/.test(llave);

const ESTADOS: Record<string, EstadoPago> = {
  APPROVED: 'aprobada',
  DECLINED: 'rechazada',
  ERROR: 'rechazada',
  VOIDED: 'anulada',
  PENDING: 'pendiente',
};

// Proveedor Wompi (Web Checkout). Usa el paquete @pulgueta/wompi (versión fija) para la firma de integridad, la
// verificación de eventos y las consultas; revisión y comparación con docs.wompi.co en AGENTS.md.
// Las llaves vienen del entorno (nunca se escriben en el código ni se registran en el log).
export const crearProveedorWompi = (llaves: LlavesWompi): ProveedorPago => {
  // Sandbox según la llave pública: con llaves de producción, la API de producción
  const cliente = new WompiClient({ publicKey: llaves.publica, privateKey: llaves.privada, sandbox: esLlaveDePrueba(llaves.publica) });

  const aResultado = (t: { id: string; status: string; reference: string; amount_in_cents?: number; currency?: string }): ResultadoPago => ({
    // Un estado que no conocemos nunca cuenta como pagado
    estado: ESTADOS[t.status] ?? 'pendiente',
    referencia: t.reference,
    // Sin monto o moneda en la respuesta, el servicio no los puede dar por buenos (no coinciden con ninguna orden)
    montoCentavos: t.amount_in_cents ?? -1,
    moneda: t.currency ?? '',
    idExterno: t.id,
  });

  return {
    nombre: 'wompi',
    async crearPago(orden: OrdenParaPago) {
      const url = await buildCheckoutUrl({
        publicKey: llaves.publica,
        reference: orden.referencia,
        amountInCents: orden.montoCentavos,
        currency: orden.moneda,
        redirectUrl: orden.urlRegreso,
        integrityKey: llaves.secretoIntegridad,
      });
      return { url };
    },
    async consultarPago({ referencia, idExterno }: ConsultaPago) {
      // Con el id que Wompi agrega al volver, se pide esa transacción; sin él, se busca por referencia
      if (idExterno) {
        const [error, t] = await cliente.transactions.getTransaction(idExterno);
        if (error) {
          registro.warn('wompi_consulta_fallo', { mensaje: error.message });
          throw error;
        }
        return aResultado(t);
      }
      const [error, lista] = await cliente.transactions.listTransactions({ reference: referencia });
      if (error) {
        registro.warn('wompi_consulta_fallo', { mensaje: error.message });
        throw error;
      }
      const propias = lista.filter((t) => t.reference === referencia);
      if (propias.length === 0) return null;
      return aResultado(propias.find((t) => t.status === 'APPROVED') ?? propias[0]);
    },
    // Verifica la firma del evento con el secreto de eventos (SHA-256 sobre las propiedades que el propio evento
    // lista, más timestamp y secreto, comparado en tiempo constante). Solo sirve para saber qué orden consultar.
    async verificarEvento(cuerpo: unknown): Promise<EventoDePago | null> {
      const [error, evento] = await verifyWebhookEvent(cuerpo, { eventsKey: llaves.secretoEventos });
      if (error || !evento) return null;
      if (!isTransactionUpdatedEvent(evento)) return null;
      const t = evento.data.transaction;
      return { referencia: t.reference, idExterno: t.id };
    },
  };
};
