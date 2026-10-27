-- Recordatorio de 2 horas, avisos de la prueba gratuita y guía inicial del negocio.

-- Marca la cita cuyo recordatorio de 2 horas ya se envió (el de 24 horas sigue en recordatorio_enviado_en).
-- Una cita reprogramada la vuelve a dejar en NULL.
ALTER TABLE citas ADD COLUMN recordatorio_2h_enviado_en timestamptz;

-- Avisos de la prueba gratuita (día 10 y día 14). La clave primaria impide enviar el mismo aviso dos veces.
-- Sin llave foránea con ON DELETE: es solo un registro de lo enviado.
CREATE TABLE avisos_prueba (
  empresa_id varchar NOT NULL,
  dia smallint NOT NULL CHECK (dia IN (10, 14)),
  enviado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, dia)
);

-- Guía inicial: cuándo se completó cada paso y si la administradora la ocultó.
-- El primer paso (tener un servicio) se calcula con los servicios activos.
ALTER TABLE empresas
  ADD COLUMN guia_horario_revisado_en timestamptz,
  ADD COLUMN guia_enlace_compartido_en timestamptz,
  ADD COLUMN guia_oculta_en timestamptz;
