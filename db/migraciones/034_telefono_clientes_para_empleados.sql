-- Opción del negocio: "los empleados pueden ver el teléfono de los clientes".
-- Apagada por defecto: todos los negocios, también los que ya existían, quedan sin mostrar el teléfono a sus
-- empleados (integrantes con rol Empleado). Los administradores siempre lo ven. Solo agrega una columna;
-- no cambia ni borra datos.
ALTER TABLE empresas ADD COLUMN empleados_ven_telefono boolean NOT NULL DEFAULT false;
