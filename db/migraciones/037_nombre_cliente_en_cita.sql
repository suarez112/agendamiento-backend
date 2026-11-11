-- Nombre del cliente tal como lo escribió (o lo vio) quien agendó la cita desde el panel.
-- Un empleado ve este nombre en su agenda, en la respuesta al agendar y en el selector de clientes, en vez del nombre
-- guardado del cliente: así, agendar con el teléfono de un cliente de otro empleado no le revela cómo está guardado.
-- Opcional: las citas que ya existían quedan en NULL y siguen mostrando el nombre guardado. Solo agrega la columna;
-- no cambia ni borra datos.
ALTER TABLE citas ADD COLUMN cliente_nombre varchar(100);
