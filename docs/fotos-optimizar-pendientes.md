# `npm run fotos:optimizar`: avisos pendientes

Avisos de prioridad baja que dejó la revisión del comando (rama `feat/fotos-optimizadas`). Ninguno bloquea: quedan
anotados para resolverlos más adelante. Código: `src/modules/empresas/optimizacionFotos.ts` y `src/db/optimizarFotos.ts`.

Ya resueltos en la misma rama: la foto compartida por dos filas (la original se conserva mientras otra fila la use), el
orden de `cambios.csv` (se anota antes de cambiar la base) y la prueba del caso en que la conversión falla.

## 1. Una carpeta de respaldo cuyo nombre empieza con `..` dentro de la carpeta de fotos

`respaldoDentroDeSubidas` considera "fuera" cualquier ruta relativa que empiece con `..`. Una subcarpeta de
`CARPETA_SUBIDAS` llamada, por ejemplo, `..copias` también empieza así, así que `--respaldo=<subidas>/..copias` pasaría la
comprobación y las originales (que pueden tener EXIF/GPS) quedarían bajo `/uploads`.

- **Impacto**: bajo. Requiere que quien ejecuta el comando pase esa carpeta a propósito, y las originales ya eran
  públicas antes de correrlo.
- **Arreglo propuesto**: comparar el primer segmento exacto (`camino === '..'` o `camino.startsWith('..' + sep)`) y
  agregar la prueba.

## 2. Una subida durante la corrida se cuenta como fallida, no como cambiada

Si un negocio sube otra foto entre la revisión y la conversión, la subida borra la original. Al leerla, el comando
recibe `ENOENT`, la cuenta como **fallida** y sale con código 1, aunque lo correcto sería contarla como **cambiada**.
La base y los archivos quedan bien; solo el resumen y el código de salida son engañosos.

- **Arreglo propuesto**: ante `ENOENT` al leer la original, volver a leer `foto_url` de la fila; si ya no apunta a la
  original, contarla como cambiada.

## 3. Un respaldo previo incompleto se acepta como bueno

Al copiar la original al respaldo, un `EEXIST` se toma como "ya hay copia" sin comprobarla. Si una corrida anterior se
cortó a mitad de la copia y se repite con el mismo `--respaldo=CARPETA`, la copia truncada se acepta y luego se borra la
original de la carpeta pública: la única copia sana se perdería.

- **Impacto**: bajo. Solo ocurre al reutilizar una carpeta de respaldo tras una corrida interrumpida; por defecto cada
  corrida usa una carpeta nueva con fecha y hora.
- **Arreglo propuesto**: ante `EEXIST`, comparar tamaño o hash con la original y, si no coinciden, fallar esa foto sin
  tocarla.

## 4. Una subida que se guarda justo después de la conversión deja un WebP huérfano

La fila se bloquea (`FOR UPDATE`) solo durante la conversión. Si una subida ya había leído la ruta original y guarda la
suya después, pisa la ruta nueva: el WebP recién creado queda sin uso en la carpeta pública y su línea de `cambios.csv`
queda desactualizada. La ventana es muy corta y no rompe ninguna imagen; solo ocupa espacio.

- **Arreglo propuesto**: correr el comando en una hora sin actividad o, si hiciera falta, una limpieza de archivos que
  ninguna fila use.
