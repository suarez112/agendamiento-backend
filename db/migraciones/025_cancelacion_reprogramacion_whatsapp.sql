-- Política de cancelación y reprogramación, WhatsApp de contacto e historial de reprogramaciones.

-- Horas de anticipación mínima para que un cliente cancele o reprograme desde la app (0 a 48, por defecto 3).
-- El negocio siempre puede cancelar. Los negocios que ya existían quedan con 3.
ALTER TABLE empresas
  ADD COLUMN anticipacion_cancelacion_horas smallint NOT NULL DEFAULT 3,
  ADD CONSTRAINT empresas_anticipacion_valida CHECK (anticipacion_cancelacion_horas BETWEEN 0 AND 48);

-- WhatsApp de contacto del negocio (opcional), en E.164 igual que los demás teléfonos
ALTER TABLE empresas ADD COLUMN whatsapp_contacto varchar(16);

-- Cada cambio de fecha u hora de una cita. Se guarda lo que había antes y lo que quedó, en hora de pared del negocio.
-- La cita se borra con su negocio; la cuenta del cliente que la movió se desvincula si se elimina.
CREATE TABLE citas_reprogramaciones (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
  cita_id varchar NOT NULL REFERENCES citas (id) ON DELETE CASCADE,
  usuario_id varchar REFERENCES usuarios (id) ON DELETE SET NULL,
  fecha_anterior date NOT NULL,
  hora_inicio_anterior time NOT NULL,
  hora_fin_anterior time NOT NULL,
  fecha_nueva date NOT NULL,
  hora_inicio_nueva time NOT NULL,
  hora_fin_nueva time NOT NULL,
  creada_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX citas_reprogramaciones_cita_idx ON citas_reprogramaciones (cita_id, creada_en);
