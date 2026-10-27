// Convierte una lista de filas planas en CSV (con BOM para que Excel respete las tildes).
// Un valor que empieza con = + - @ se antecede con ' para que una hoja de cálculo no lo ejecute como fórmula.
export const neutralizarFormula = (texto: string) => (/^[=+\-@\t\r]/.test(texto) ? `'${texto}` : texto);

const celda = (valor: unknown) => {
  if (valor === null || valor === undefined) return '';
  let texto = String(valor);
  if (typeof valor === 'string') texto = neutralizarFormula(texto);
  return /[",\n\r]/.test(texto) ? `"${texto.replaceAll('"', '""')}"` : texto;
};

export const aCsv = (filas: Record<string, unknown>[]) => {
  if (!filas.length) return '﻿';
  const columnas = Object.keys(filas[0]);
  const lineas = [columnas.join(','), ...filas.map((f) => columnas.map((c) => celda(f[c])).join(','))];
  return `﻿${lineas.join('\r\n')}\r\n`;
};
