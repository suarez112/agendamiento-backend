-- Esquema existente antes del endurecimiento. Es idempotente: en una base que ya
-- tiene las tablas no cambia nada; en una base vacía la deja igual que producción.

CREATE TABLE IF NOT EXISTS empresas (
  id varchar PRIMARY KEY,
  nombre varchar NOT NULL,
  codigo_acceso varchar NOT NULL CONSTRAINT empresas_codigo_acceso_key UNIQUE,
  color_primario varchar DEFAULT '#EAB308',
  color_secundario varchar DEFAULT '#0D0D0D',
  horario_apertura time NOT NULL DEFAULT '08:00:00',
  horario_cierre time NOT NULL DEFAULT '20:00:00',
  created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS barberos (
  id varchar PRIMARY KEY,
  empresa_id varchar REFERENCES empresas (id) ON DELETE CASCADE,
  nombre varchar NOT NULL,
  usuario varchar NOT NULL CONSTRAINT barberos_usuario_key UNIQUE,
  password_hash varchar NOT NULL,
  es_admin boolean DEFAULT false,
  especialidad varchar DEFAULT 'Estilista · Especialista',
  porcentaje_ganancia numeric DEFAULT 50.00,
  foto_url text,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS servicios (
  id varchar PRIMARY KEY,
  empresa_id varchar REFERENCES empresas (id) ON DELETE CASCADE,
  nombre varchar NOT NULL,
  duracion_min integer NOT NULL,
  precio numeric NOT NULL,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS productos (
  id varchar PRIMARY KEY,
  empresa_id varchar REFERENCES empresas (id) ON DELETE CASCADE,
  nombre varchar NOT NULL,
  precio numeric NOT NULL,
  foto_url text,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clientes (
  id varchar PRIMARY KEY,
  empresa_id varchar REFERENCES empresas (id) ON DELETE CASCADE,
  telefono varchar NOT NULL,
  nombre varchar NOT NULL,
  total_citas integer DEFAULT 1,
  fecha_ultima_cita date,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  indicativo varchar NOT NULL DEFAULT '57',
  CONSTRAINT uq_cliente_empresa_tel UNIQUE (empresa_id, telefono)
);

CREATE TABLE IF NOT EXISTS citas (
  id varchar PRIMARY KEY,
  empresa_id varchar REFERENCES empresas (id) ON DELETE CASCADE,
  barbero_id varchar REFERENCES barberos (id) ON DELETE CASCADE,
  servicio_id varchar REFERENCES servicios (id),
  cliente_id varchar REFERENCES clientes (id),
  fecha date NOT NULL,
  hora_inicio time NOT NULL,
  hora_fin time NOT NULL,
  precio numeric NOT NULL,
  estado varchar DEFAULT 'CONFIRMADA',
  completada_por varchar REFERENCES barberos (id),
  completada_en timestamp,
  cancelada_por varchar REFERENCES barberos (id),
  cancelada_en timestamp,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bloqueos (
  id varchar PRIMARY KEY,
  barbero_id varchar REFERENCES barberos (id) ON DELETE CASCADE,
  dia_semana integer,
  fecha_especifica date,
  hora_inicio time NOT NULL,
  hora_fin time NOT NULL,
  es_repetitivo boolean DEFAULT false,
  motivo varchar,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lista_negra (
  id varchar PRIMARY KEY,
  empresa_id varchar REFERENCES empresas (id) ON DELETE CASCADE,
  nombre varchar NOT NULL,
  telefono varchar NOT NULL,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_listanegra_empresa_tel UNIQUE (empresa_id, telefono)
);
