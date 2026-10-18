-- Cartera: la ganancia de cada cita usa el porcentaje que tenía el profesional
-- cuando se completó, no el de hoy. Cambiar el porcentaje de un barbero ya no
-- cambia lo que ganó en citas pasadas.

ALTER TABLE citas
  ADD COLUMN porcentaje_ganancia numeric,
  ADD CONSTRAINT citas_porcentaje_valido
    CHECK (porcentaje_ganancia IS NULL OR porcentaje_ganancia BETWEEN 0 AND 100);

-- Citas ya completadas: no se sabe qué porcentaje tenían, así que se toma el
-- porcentaje actual del profesional como valor inicial.
UPDATE citas c
SET porcentaje_ganancia = b.porcentaje_ganancia
FROM barberos b
WHERE b.id = c.barbero_id AND c.estado = 'COMPLETADA';

-- Toda cita completada tiene su porcentaje guardado
ALTER TABLE citas
  ADD CONSTRAINT citas_completada_con_porcentaje
    CHECK (estado <> 'COMPLETADA' OR porcentaje_ganancia IS NOT NULL);
