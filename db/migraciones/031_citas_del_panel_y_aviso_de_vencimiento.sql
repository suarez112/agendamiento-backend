-- Citas creadas desde el panel: la prueba de la autorización guarda el canal 'registro_negocio'
-- (el negocio registra que el cliente autorizó el tratamiento de sus datos).
-- La tabla sigue siendo de solo inserción: aquí solo se amplía la lista de canales válidos.
ALTER TABLE auditoria_autorizaciones DROP CONSTRAINT auditoria_autorizaciones_canal_valido;
ALTER TABLE auditoria_autorizaciones
  ADD CONSTRAINT auditoria_autorizaciones_canal_valido
  CHECK (canal IN ('registro_empresa', 'registro_cliente', 'reserva_invitado', 'nueva_version', 'registro_negocio'));

-- Aviso de la prueba gratuita al vencer (día 15), además de los del día 10 y el día 14
ALTER TABLE avisos_prueba DROP CONSTRAINT avisos_prueba_dia_check;
ALTER TABLE avisos_prueba ADD CONSTRAINT avisos_prueba_dia_check CHECK (dia IN (10, 14, 15));
