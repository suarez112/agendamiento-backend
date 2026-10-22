// Enlace público de un negocio: <base>/<CÓDIGO>. La base viene de ENLACE_PUBLICO_BASE
// (ya con protocolo y sin barra final).
export const enlacePublico = (base: string, codigoAcceso: string) => `${base}/${codigoAcceso}`;
