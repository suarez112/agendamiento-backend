-- PQRS: peticiones, quejas, reclamos y sugerencias. Cada una recibe un número de
-- radicado (PQRS-AAAA-NNNNNN) y un estado que cambia el equipo de soporte.
-- Si la persona tenía sesión, se guarda su cuenta; al eliminar la cuenta la PQRS
-- se conserva (es un registro de atención) pero sin nombre ni contacto.
CREATE SEQUENCE pqrs_numero_seq;

CREATE TABLE pqrs (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
  radicado varchar(20) NOT NULL,
  tipo varchar(12) NOT NULL,
  mensaje varchar(2000) NOT NULL,
  nombre varchar(100) NOT NULL,
  contacto varchar(150) NOT NULL,
  usuario_id varchar REFERENCES usuarios (id) ON DELETE SET NULL,
  estado varchar(12) NOT NULL DEFAULT 'recibida',
  respuesta varchar(2000),
  respondida_en timestamptz,
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pqrs_radicado_key UNIQUE (radicado),
  CONSTRAINT pqrs_tipo_valido CHECK (tipo IN ('peticion', 'queja', 'reclamo', 'sugerencia')),
  CONSTRAINT pqrs_estado_valido CHECK (estado IN ('recibida', 'en_proceso', 'resuelta', 'cerrada'))
);

CREATE INDEX pqrs_usuario_idx ON pqrs (usuario_id, creado_en DESC) WHERE usuario_id IS NOT NULL;
CREATE INDEX pqrs_estado_idx ON pqrs (estado, creado_en);
