-- Roles del equipo, planes de suscripción, cuentas de cliente y autorizaciones
-- de tratamiento de datos (Ley 1581 de 2012).
-- Solo agrega columnas, tablas, restricciones e índices, y quita el NOT NULL del
-- correo de las cuentas. Los datos actuales no cambian.

-- 1. Equipo: "Atiende clientes". Quien no atiende no recibe reservas.
--    Todo el equipo actual ya recibía reservas, así que queda en true.
ALTER TABLE barberos ADD COLUMN atiende_clientes boolean NOT NULL DEFAULT true;

-- 2. Plan de la suscripción. Una empresa activa con plan sabe cuándo pagó y
--    cuándo termina. Las empresas activas de antes (sin plan) no tienen fecha de fin.
ALTER TABLE empresas
  ADD COLUMN plan_suscripcion varchar(10),
  ADD COLUMN fecha_pago date,
  ADD COLUMN suscripcion_fin date,
  ADD CONSTRAINT empresas_plan_valido
    CHECK (plan_suscripcion IS NULL OR plan_suscripcion IN ('mensual', 'anual')),
  ADD CONSTRAINT empresas_plan_con_fechas
    CHECK (plan_suscripcion IS NULL OR (fecha_pago IS NOT NULL AND suscripcion_fin IS NOT NULL));

-- 3. Cuentas de cliente: nombre y teléfono para reservar, y correo o usuario
--    para iniciar sesión. La administradora sigue necesitando los dos.
ALTER TABLE usuarios
  ALTER COLUMN correo DROP NOT NULL,
  ADD COLUMN nombre varchar(100),
  ADD COLUMN telefono varchar(30),
  ADD COLUMN indicativo varchar(4),
  ADD CONSTRAINT usuarios_admin_con_correo CHECK (rol <> 'admin' OR correo IS NOT NULL),
  ADD CONSTRAINT usuarios_correo_o_usuario CHECK (correo IS NOT NULL OR usuario IS NOT NULL),
  ADD CONSTRAINT usuarios_indicativo_valido CHECK (indicativo IS NULL OR indicativo ~ '^[0-9]{1,4}$');

-- Negocios que un cliente guardó para no escribir el código cada vez. Se guarda
-- la empresa, no el código: si el negocio cambia su código, sigue en la lista.
CREATE TABLE negocios_guardados (
  usuario_id varchar NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  empresa_id varchar NOT NULL REFERENCES empresas (id) ON DELETE CASCADE,
  guardado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, empresa_id)
);

-- Cuenta del cliente que reservó con su sesión (NULL = reserva como invitado)
ALTER TABLE citas ADD COLUMN usuario_id varchar REFERENCES usuarios (id) ON DELETE SET NULL;
CREATE INDEX citas_usuario_idx ON citas (usuario_id) WHERE usuario_id IS NOT NULL;

-- 4. Política de Tratamiento de Datos y Términos y Condiciones. Cada versión
--    publicada es una fila nueva y nunca se modifica: la vigente es la más reciente.
CREATE TABLE documentos_legales (
  tipo varchar(20) NOT NULL,
  version varchar(30) NOT NULL,
  titulo varchar(200) NOT NULL,
  contenido text NOT NULL,
  publicado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tipo, version),
  CONSTRAINT documentos_legales_tipo_valido CHECK (tipo IN ('politica_datos', 'terminos'))
);

-- Prueba de cada autorización: quién (cuenta o teléfono del invitado), cuándo,
-- desde dónde y qué versiones aceptó. Se acepta siempre la política y los términos juntos.
CREATE TABLE autorizaciones_datos (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
  origen varchar(20) NOT NULL,
  usuario_id varchar REFERENCES usuarios (id) ON DELETE CASCADE,
  telefono varchar(30),
  indicativo varchar(4),
  empresa_id varchar REFERENCES empresas (id) ON DELETE CASCADE,
  cita_id varchar REFERENCES citas (id) ON DELETE SET NULL,
  version_politica varchar(30) NOT NULL,
  version_terminos varchar(30) NOT NULL,
  aceptado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT autorizaciones_origen_valido
    CHECK (origen IN ('registro_empresa', 'registro_cliente', 'reserva')),
  CONSTRAINT autorizaciones_con_titular CHECK (usuario_id IS NOT NULL OR telefono IS NOT NULL)
);

CREATE INDEX autorizaciones_usuario_idx ON autorizaciones_datos (usuario_id) WHERE usuario_id IS NOT NULL;
