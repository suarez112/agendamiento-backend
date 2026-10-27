-- Notificaciones push (Expo Push).
-- 1. dispositivos_push: el token de cada celular con sesión. Un token es de una sola
--    persona a la vez (si otra persona inicia sesión en ese celular, el token cambia
--    de dueño). Pertenece a un integrante del equipo (barbero_id) o a una cuenta
--    (usuario_id: administradora o cliente), nunca a las dos. Se borra con su dueño.
-- 2. citas.recordatorio_enviado_en: marca la cita cuyo recordatorio de 24 horas ya
--    se envió, para no enviarlo dos veces.

CREATE TABLE dispositivos_push (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
  token varchar(200) NOT NULL,
  usuario_id varchar REFERENCES usuarios (id) ON DELETE CASCADE,
  barbero_id varchar REFERENCES barberos (id) ON DELETE CASCADE,
  plataforma varchar(10),
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispositivos_push_token_key UNIQUE (token),
  CONSTRAINT dispositivos_push_un_dueno CHECK ((usuario_id IS NULL) <> (barbero_id IS NULL)),
  CONSTRAINT dispositivos_push_plataforma_valida CHECK (plataforma IS NULL OR plataforma IN ('ios', 'android', 'web'))
);

CREATE INDEX dispositivos_push_usuario_idx ON dispositivos_push (usuario_id) WHERE usuario_id IS NOT NULL;
CREATE INDEX dispositivos_push_barbero_idx ON dispositivos_push (barbero_id) WHERE barbero_id IS NOT NULL;

ALTER TABLE citas ADD COLUMN recordatorio_enviado_en timestamptz;

-- La tarea de recordatorios solo mira citas confirmadas, de clientes con cuenta y sin recordatorio
CREATE INDEX citas_recordatorio_pendiente_idx ON citas (fecha)
  WHERE estado = 'CONFIRMADA' AND usuario_id IS NOT NULL AND recordatorio_enviado_en IS NULL;
