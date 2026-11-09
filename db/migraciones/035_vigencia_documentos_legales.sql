-- Effective date of each legal document version ("Vigente desde"), shown by the app
-- under the title. Older versions keep NULL (1.0 had a placeholder instead of a date).
-- Only adds a nullable column; no existing row changes.
ALTER TABLE documentos_legales ADD COLUMN vigente_desde date;
