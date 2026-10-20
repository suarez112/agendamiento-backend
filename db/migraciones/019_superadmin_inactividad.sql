-- Cierre de sesión del superadmin por inactividad.
-- Solo agrega una columna: los datos actuales no cambian.

-- Momento de la última solicitud autenticada del superadmin. Si pasan más de 15 minutos
-- sin actividad (o es NULL, porque cerró sesión o aún no entró), el token deja de servir.
ALTER TABLE superadmins ADD COLUMN ultima_actividad timestamptz;
