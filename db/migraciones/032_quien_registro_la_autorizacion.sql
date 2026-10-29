-- Citas creadas desde el panel: quién del negocio declaró que el cliente autorizó el tratamiento de sus datos.
-- Son columnas aparte de usuario_id / barbero_id (que identifican a quien ACEPTÓ): así la declaración de un
-- miembro del equipo nunca cuenta como aceptación suya de la política. Sin llaves foráneas, como el resto de la
-- tabla (solo de inserción: se conserva aunque la persona se elimine). Las filas anteriores quedan en NULL.
ALTER TABLE auditoria_autorizaciones
  ADD COLUMN registrada_por_barbero_id varchar,
  ADD COLUMN registrada_por_usuario_id varchar,
  ADD CONSTRAINT auditoria_autorizaciones_quien_registro CHECK (
    (canal = 'registro_negocio' AND num_nonnulls(registrada_por_barbero_id, registrada_por_usuario_id) = 1)
    OR (canal <> 'registro_negocio' AND num_nonnulls(registrada_por_barbero_id, registrada_por_usuario_id) = 0)
  ) NOT VALID;
