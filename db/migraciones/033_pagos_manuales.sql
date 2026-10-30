-- Pagos manuales (Nequi, llave Bre-B y código QR) con comprobante por WhatsApp.
-- Agrega una tabla y columnas nuevas; los datos actuales no cambian. La integración con la pasarela (Wompi) no se toca.

-- 1. Formas de pago que muestra la app. Una sola fila (la configura el superadmin). Los QR se guardan en la base,
--    no en la carpeta pública de fotos: solo los lee un administrador de negocio con sesión.
--    Sin llaves foráneas (como el resto de la auditoría): quién la cambió y cuándo queda copiado en la fila y,
--    además, cada cambio queda en actividad_superadmin.
CREATE TABLE formas_pago_manual (
  id boolean PRIMARY KEY DEFAULT true,
  titular varchar(100) NOT NULL,
  -- WhatsApp que recibe los comprobantes (E.164)
  whatsapp varchar(16) NOT NULL,
  nequi_numero varchar(10),
  nequi_activo boolean NOT NULL DEFAULT false,
  llave_breb varchar(60),
  llave_breb_activa boolean NOT NULL DEFAULT false,
  qr_activo boolean NOT NULL DEFAULT false,
  qr_nequi bytea,
  qr_nequi_tipo varchar(10),
  qr_breb bytea,
  qr_breb_tipo varchar(10),
  actualizado_por_id varchar NOT NULL,
  actualizado_por_correo varchar(254) NOT NULL,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT formas_pago_manual_una_fila CHECK (id),
  CONSTRAINT formas_pago_manual_al_menos_una CHECK (nequi_activo OR llave_breb_activa OR qr_activo),
  CONSTRAINT formas_pago_manual_nequi_completo CHECK (NOT nequi_activo OR nequi_numero IS NOT NULL),
  CONSTRAINT formas_pago_manual_llave_completa CHECK (NOT llave_breb_activa OR llave_breb IS NOT NULL),
  CONSTRAINT formas_pago_manual_qr_completo CHECK (NOT qr_activo OR qr_nequi IS NOT NULL OR qr_breb IS NOT NULL),
  CONSTRAINT formas_pago_manual_qr_nequi_valido CHECK (
    (qr_nequi IS NULL AND qr_nequi_tipo IS NULL)
    OR (octet_length(qr_nequi) BETWEEN 1 AND 1048576 AND qr_nequi_tipo IN ('image/png', 'image/jpeg', 'image/webp'))
  ),
  CONSTRAINT formas_pago_manual_qr_breb_valido CHECK (
    (qr_breb IS NULL AND qr_breb_tipo IS NULL)
    OR (octet_length(qr_breb) BETWEEN 1 AND 1048576 AND qr_breb_tipo IN ('image/png', 'image/jpeg', 'image/webp'))
  )
);

-- 2. Órdenes manuales: quién las revisó, cuándo y con qué motivo. Una orden manual en estado 'pendiente' está
--    pendiente de verificación. Las demás columnas de ordenes_pago se reutilizan tal cual.
ALTER TABLE ordenes_pago
  ADD COLUMN revisada_por_id varchar,
  ADD COLUMN revisada_por_correo varchar(254),
  ADD COLUMN revisada_en timestamptz,
  ADD COLUMN motivo_revision varchar(300);

-- Un negocio solo puede tener una orden manual pendiente a la vez (crear otra anula la anterior en la misma transacción;
-- este índice es la última defensa ante dos solicitudes simultáneas)
CREATE UNIQUE INDEX ordenes_pago_manual_pendiente_key ON ordenes_pago (empresa_id)
  WHERE proveedor = 'manual' AND estado = 'pendiente';

-- Para la lista del superadmin
CREATE INDEX ordenes_pago_manual_estado_idx ON ordenes_pago (estado, creada_en) WHERE proveedor = 'manual';

-- 3. Origen 'manual' en el historial de activaciones
ALTER TABLE activaciones_plan DROP CONSTRAINT activaciones_plan_origen_valido;
ALTER TABLE activaciones_plan
  ADD CONSTRAINT activaciones_plan_origen_valido CHECK (origen IN ('panel', 'comando', 'historico', 'pasarela', 'manual'));
