// Zona horaria que se asigna a un negocio según su país (código ISO 3166-1 alfa-2).
// Para países con varias zonas se usa la de la capital; el negocio puede enviar otra
// ("zonaHoraria") al registrarse y cambiarla después en Mi negocio.

export const ZONA_POR_PAIS: Record<string, string> = {
  AR: 'America/Argentina/Buenos_Aires',
  BO: 'America/La_Paz',
  BR: 'America/Sao_Paulo',
  CA: 'America/Toronto',
  CL: 'America/Santiago',
  CO: 'America/Bogota',
  CR: 'America/Costa_Rica',
  CU: 'America/Havana',
  DO: 'America/Santo_Domingo',
  EC: 'America/Guayaquil',
  ES: 'Europe/Madrid',
  GT: 'America/Guatemala',
  HN: 'America/Tegucigalpa',
  MX: 'America/Mexico_City',
  NI: 'America/Managua',
  PA: 'America/Panama',
  PE: 'America/Lima',
  PR: 'America/Puerto_Rico',
  PY: 'America/Asuncion',
  SV: 'America/El_Salvador',
  US: 'America/New_York',
  UY: 'America/Montevideo',
  VE: 'America/Caracas',
};

export const PAIS_POR_DEFECTO = 'CO';
