-- Foto del negocio subida por el administrador. Solo agrega una columna;
-- los datos actuales no cambian.
-- Guarda la ruta del archivo dentro del servidor (ej. /uploads/empresas/<uuid>.jpg),
-- no la dirección completa: así la foto sigue sirviendo si cambia el dominio.
-- La API la devuelve como dirección completa (fotoUrl).
ALTER TABLE empresas
  ADD COLUMN foto_url varchar(200),
  ADD CONSTRAINT empresas_foto_url_valida
    CHECK (foto_url IS NULL OR foto_url ~ '^/uploads/empresas/[a-f0-9-]{36}\.(jpg|png|webp)$');
