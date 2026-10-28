-- Pagos con pasarela: órdenes de pago. Agrega una tabla y permite el origen 'pasarela' en el historial de
-- activaciones; los datos actuales no cambian.
-- Sin llave foránea a empresas a propósito (como cargos y activaciones_plan): la orden se conserva como
-- evidencia del cobro y copia el código del negocio de ese momento.

CREATE TABLE ordenes_pago (
  id bigserial PRIMARY KEY,
  -- Referencia única que se envía a la pasarela (máx. 40 caracteres: límite de Wompi)
  referencia varchar(40) NOT NULL UNIQUE,
  empresa_id varchar NOT NULL,
  empresa_codigo varchar,
  -- simulado | wompi
  proveedor varchar(12) NOT NULL,
  profesionales integer NOT NULL,
  periodo varchar(10) NOT NULL,
  -- El monto se guarda en centavos, como lo exige la pasarela; moneda siempre COP
  monto_centavos bigint NOT NULL,
  moneda varchar(3) NOT NULL DEFAULT 'COP',
  estado varchar(10) NOT NULL DEFAULT 'pendiente',
  -- Identificador de la transacción en la pasarela (llega al volver del pago)
  id_externo varchar(100),
  -- Solo lo usa el proveedor simulado: lo que "decidió" la pantalla de pago de pruebas
  resultado_simulado varchar(10),
  creada_en timestamptz NOT NULL DEFAULT now(),
  actualizada_en timestamptz NOT NULL DEFAULT now(),
  -- Momento en que se activó el plan con esta orden; una orden solo se activa una vez
  activada_en timestamptz,
  CONSTRAINT ordenes_pago_periodo_valido CHECK (periodo IN ('mensual', 'anual')),
  CONSTRAINT ordenes_pago_estado_valido CHECK (estado IN ('pendiente', 'aprobada', 'rechazada', 'anulada')),
  CONSTRAINT ordenes_pago_monto_valido CHECK (monto_centavos > 0),
  CONSTRAINT ordenes_pago_profesionales_valido CHECK (profesionales BETWEEN 1 AND 10),
  CONSTRAINT ordenes_pago_resultado_simulado_valido CHECK (resultado_simulado IS NULL OR resultado_simulado IN ('aprobada', 'rechazada')),
  -- Solo una orden aprobada puede estar activada
  CONSTRAINT ordenes_pago_activada_solo_aprobada CHECK (activada_en IS NULL OR estado = 'aprobada')
);

CREATE INDEX ordenes_pago_empresa_idx ON ordenes_pago (empresa_id, creada_en DESC);
-- Una transacción de la pasarela no puede pagar dos órdenes
CREATE UNIQUE INDEX ordenes_pago_id_externo_key ON ordenes_pago (proveedor, id_externo) WHERE id_externo IS NOT NULL;

ALTER TABLE activaciones_plan DROP CONSTRAINT activaciones_plan_origen_valido;
ALTER TABLE activaciones_plan
  ADD CONSTRAINT activaciones_plan_origen_valido CHECK (origen IN ('panel', 'comando', 'historico', 'pasarela'));
