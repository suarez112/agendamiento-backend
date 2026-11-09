import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { separarDocumentosLegales, sqlPublicarVersion } from './documentosLegales.js';

// npm run legal:generar-migracion -- <source .md> <version> <migration file name>
// e.g. -- docs/legal/agendality_documentos_legales_v1.1.md 1.1 035_documentos_legales_v1_1.sql
// Reads the legal source file and writes a new SQL migration with its exact text, so
// nothing is copied by hand. Never overwrites an existing migration.
const [fuente, version, nombre] = process.argv.slice(2);
if (!fuente || !version || !nombre || !/^\d{3}_[a-z0-9_]+\.sql$/.test(nombre) || !/^\d+\.\d+$/.test(version)) {
  console.error('Usage: npm run legal:generar-migracion -- <source .md> <version, e.g. 1.1> <NNN_name.sql>');
  process.exit(1);
}

const destino = fileURLToPath(new URL(`../../db/migraciones/${nombre}`, import.meta.url));
if (existsSync(destino)) {
  console.error(`✖ ${nombre} already exists; migrations are never edited.`);
  process.exit(1);
}

const documentos = separarDocumentosLegales(readFileSync(fuente, 'utf8'));
writeFileSync(destino, sqlPublicarVersion(version, documentos, fuente.replace(/\\/g, '/')), 'utf8');
console.log(`✔ db/migraciones/${nombre}: ${documentos.map((d) => `${d.tipo} (${d.contenido.length} chars)`).join(', ')}`);
