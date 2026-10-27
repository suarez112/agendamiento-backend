import { Router } from 'express';
import { DEPARTAMENTOS } from './divipola.js';

// Compara sin tildes, mayúsculas ni espacios de más: "bogotá d.c." = "BOGOTA, D.C."
const normalizar = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

// Cada nombre se busca normalizado; "BOGOTÁ, D.C." también se encuentra como "Bogotá"
const claves = (nombre: string) => {
  const clave = normalizar(nombre);
  return clave.endsWith(' D C') ? [clave, clave.slice(0, -4)] : [clave];
};

// Nombres de uso común que no coinciden con el nombre oficial (código DANE → alias)
const ALIAS: Record<string, string[]> = {
  '76': ['VALLE'],
  '88': ['SAN ANDRES', 'SAN ANDRES Y PROVIDENCIA'],
  '13001': ['CARTAGENA'],
  '25843': ['UBATE'],
  '52835': ['TUMACO'],
  '54001': ['CUCUTA'],
  '73443': ['MARIQUITA'],
  '76111': ['BUGA'],
};

const porDepartamento = new Map(
  DEPARTAMENTOS.flatMap((d) => {
    const municipios = new Map(
      d.municipios.flatMap(([codigo, nombre]) =>
        [...claves(nombre), ...(ALIAS[codigo] ?? [])].map((c) => [c, nombre] as const),
      ),
    );
    return [...claves(d.nombre), ...(ALIAS[d.codigo] ?? [])].map((c) => [c, { nombre: d.nombre, municipios }] as const);
  }),
);

// Nombre oficial del departamento; undefined si no es un departamento de Colombia
export const departamentoOficial = (departamento: string) => porDepartamento.get(normalizar(departamento))?.nombre;

// Nombre oficial del municipio dentro de ese departamento; undefined si no pertenece
export const municipioOficial = (departamento: string, municipio: string) =>
  porDepartamento.get(normalizar(departamento))?.municipios.get(normalizar(municipio));

// Lista pública para que la app ofrezca los departamentos y sus municipios
const LISTA = DEPARTAMENTOS.map((d) => ({
  codigo: d.codigo,
  nombre: d.nombre,
  municipios: d.municipios.map(([codigo, nombre]) => ({ codigo, nombre })),
}));

export const crearRutasUbicaciones = () => {
  const rutas = Router();
  rutas.get('/', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400').json(LISTA);
  });
  return rutas;
};
