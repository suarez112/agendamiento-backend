# AGENTS.md — agendamiento-backend

API REST (Express 5 + TypeScript + PostgreSQL) para agendar citas en barberías. Varios negocios comparten la base; cada uno solo ve sus datos. Detalle completo en `README.md`.

**Este repositorio es solo el backend.** El frontend (Expo/React Native) está en `C:\Users\eduar_9\app`; no lo modifiques desde aquí.

**Servidor durante el desarrollo:** el backend ya está encendido en el puerto 4000 con `npm run dev` (se recarga solo al guardar). **No lo inicies ni lo apagues.** Para comprobar un cambio, llama a los endpoints (`http://localhost:4000`). No hay emulador: lo visual lo prueba el usuario en su celular.

## Estructura

```
src/
  server.ts          arranque y apagado ordenado
  app.ts             crea servicios y conecta rutas (recibe pool y entorno)
  config/entorno.ts  variables de entorno validadas con zod
  db/                pool, migraciones (migrar.ts) y scripts de mantenimiento
  shared/            errores, logs JSON, middlewares HTTP (CORS, límites, validación, errores)
  shared/telefonos.ts  validación y formato E.164 de los teléfonos (libphonenumber-js)
  modules/<modulo>/  auth, cuentas, empresas, citas, clientes, equipo, servicios, productos, bloqueos, cartera: <m>.rutas.ts (HTTP + zod) → <m>.servicio.ts (reglas) → <m>.repositorio.ts (SQL)
  modules/auth/acceso.ts          login único (correo o usuario)
  modules/empresas/horario.ts     horario por día (tabla horarios_empresa)
  modules/ubicaciones/            departamentos y municipios de Colombia (DIVIPOLA del DANE, divipola.ts generado)
  modules/empresas/suscripcion.ts estado de la suscripción y guardia 402
  modules/legal/legal.ts          política y términos vigentes, prueba de las autorizaciones (Ley 1581)
  modules/micuenta/               cuenta del cliente: negocios guardados y sus citas
  db/activarPlan.ts, db/simularVencimiento.ts   comandos de desarrollador (ver "Comandos de desarrollador")
db/migraciones/      numeradas NNN_nombre.sql (o .ts si SQL no alcanza); cada archivo en su propia transacción
test/                node:test; cada archivo crea y borra su propia base temporal
odd/tasks/           bitácoras de trabajo (specs, tareas, evidencia)
```

Un módulo nuevo copia la forma rutas → servicio → repositorio y se conecta en `src/app.ts`.

## Ejecutar

```bash
npm install
npm run db:migrate   # aplica migraciones pendientes (anotadas en schema_migrations)
npm run dev          # http://localhost:4000  (salud: GET /api/saludo)
npm run typecheck    # tipos de src/ y test/
npm test             # integración; requiere PostgreSQL y permiso CREATEDB
```

### Comandos de desarrollador (suscripciones)

No hay pagos reales. Para probar las suscripciones se usan dos comandos. `CODIGO` es el código del negocio (sin distinguir mayúsculas). Lee la base del `.env`; no hace falta tener el servidor encendido.

```bash
npm run dev:activar-plan -- CODIGO mensual     # o: anual
npm run dev:simular-vencimiento -- CODIGO DIAS # ej. 3, 0 o -2
```

- **`dev:activar-plan`**: deja la empresa `activa` con ese plan, de inmediato (ya no aparece como prueba). Fecha de pago = hoy (Colombia). Fecha de fin = 1 mes o 1 año contados desde: el **fin de la prueba**, si paga durante la prueba (no pierde los días gratis que le quedaban; se guardan en `dias_prueba_sumados` y `/suscripcion` los muestra en `diasPruebaSumados`); el fin del plan actual, si aún no vencía (una renovación anticipada no pierde días); o hoy, en otro caso. Sirve también para activar a mano un negocio en producción mientras no haya pagos. Ejemplo: `npm run dev:activar-plan -- CENTRAL10 anual` → `✔ Barbería Central (CENTRAL10): plan anual activo. Pago: 2026-10-19. Fin: 2027-10-19. Días restantes: 365.` Durante una prueba con 15 días restantes, `-- CENTRAL10 mensual` → `… Fin: 2026-12-03. Días restantes: 45. Días de prueba sumados: 15.`
- **`dev:simular-vencimiento`**: deja a la empresa con `DIAS` días restantes de su prueba (si está en prueba) o de su plan (si está activa), cambiando la fecha de fin. `0` o negativo = vencida. Para un negocio vencido, actívale antes un plan. **No funciona con `NODE_ENV=production`** (responde con error y no cambia nada). Ejemplos: `-- CENTRAL10 5` (recordatorio de los últimos 7 días), `-- CENTRAL10 0` (vencida hoy).

Los dos muestran cómo quedó: estado, fecha de fin y días restantes.

Puerto por defecto `4000` (`PORT`). Rutas bajo `/api/v1`.

## Base de datos y entorno

- PostgreSQL vía `pg` (`src/db/pool.ts`), con las extensiones `btree_gist` (migración 002) y `gen_random_uuid()` (PostgreSQL 13 o superior).
- Variables en `.env` en la raíz (ignorado por git; nunca lo subas). Se validan al arrancar en `src/config/entorno.ts`: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_MAX`, `JWT_SECRET`, `JWT_EXPIRA_EN`, `CORS_ORIGINS`, `TRUST_PROXY`, `NODE_ENV`, `PORT`, `CARPETA_SUBIDAS` (opcional, por defecto `uploads`: carpeta de las fotos subidas, ignorada por git) y `URL_PUBLICA` (opcional: dirección pública del servidor, ej. `https://api.mibarberia.co`, para armar las URL de las fotos; si falta se usa la dirección de cada solicitud, así que configúrala en producción).
- El esquema solo cambia con un archivo nuevo en `db/migraciones/` (siguiente número). Nunca edites una migración ya aplicada. Casi siempre es `.sql`; si hace falta código (ej. una librería), puede ser `.ts` y exportar por defecto `async (db: pg.PoolClient) => {…}`, que corre en la misma transacción (ver la 011). Una migración `.ts` no importa nada de `src/`, para que siga haciendo lo mismo aunque el código cambie.
- Migración 007: horario por día en `horarios_empresa` (un día sin fila = cerrado; reemplaza `dias_atencion`, `horario_apertura` y `horario_cierre`, que se copiaron ahí), quita `nit`, `telefono` y `correo` de `empresas`, agrega `empresas.departamento`, empleados de 1 a 10, código del negocio `^[A-Z0-9]{1,10}$`, `usuarios.usuario` y bloqueos semanales o de una fecha (`bloqueos_tipo_valido`). La 008 corrige el trigger de usuario único.
- Migración 009: `barberos.atiende_clientes`; plan de la suscripción (`empresas.plan_suscripcion` `mensual`|`anual`, `fecha_pago`, `suscripcion_fin`); cuentas de cliente (`usuarios.nombre`, `telefono`, `indicativo`; `correo` pasa a opcional: correo o usuario); `negocios_guardados`; `citas.usuario_id` (cliente que reservó con su sesión); `documentos_legales` y `autorizaciones_datos`. La 010 publica el borrador `0.1-borrador` de la política y los términos.
- Migración 011 (`.ts`): **teléfonos en E.164** (`+573162781393`) en `varchar(16)` en `clientes`, `lista_negra`, `usuarios` y `autorizaciones_datos`. `clientes` pasa a ser único por `(empresa_id, telefono)`; índice único `usuarios_telefono_cliente_key` en `usuarios (telefono) WHERE rol = 'cliente'`. `lista_negra` sigue única por negocio. Los teléfonos que no se pudieron convertir **no se borraron**: quedaron solo con sus dígitos (no empiezan con `+`). Para verlos: `SELECT id, empresa_id, nombre, telefono FROM clientes WHERE telefono !~ '^\+'` (igual en las otras tablas). Al aplicarla quedaron 2 pendientes en `clientes`: `3768300614` (Popo) y `357491541` (DESQ), ambos del negocio INFINITY.
- Migración 012: `empresas.latitud` y `empresas.longitud` (opcionales, siempre juntas, rangos validados) y `empresas.dias_prueba_sumados` (días de prueba que quedaban al pagar durante la prueba).
- **Publicar una versión nueva de la política o los términos**: una migración nueva que inserte una fila en `documentos_legales` con otra `version` (nunca edites las filas publicadas). La más reciente es la vigente; los clientes con cuenta la aceptan en su próxima reserva.

## Endpoints

Todas las respuestas son JSON. Los errores siempre llegan como `{ "error": "mensaje" }`, listo para mostrar al usuario.

| Método | Ruta | Acceso |
| --- | --- | --- |
| GET | `/api/saludo` | público (salud) |
| POST | `/api/v1/login` | público, limitado. **Login único**: administradora, personal o cliente con cuenta. Cuerpo `{ usuario: "correo o usuario", clave }` |
| POST | `/api/v1/auth/login` | público, limitado. Personal (barberos). Cuerpo `{ usuario, clave }` (se mantiene) |
| GET | `/api/v1/ubicaciones` | público. Departamentos de Colombia con sus municipios |
| GET | `/api/v1/legal/politica-datos` | público. Texto vigente de la Política de Tratamiento de Datos, con su versión |
| GET | `/api/v1/legal/terminos` | público. Texto vigente de los Términos y Condiciones, con su versión |
| GET | `/api/v1/empresas/codigo-disponible/:codigo` | público, limitado. ¿Algún negocio usa ya ese código? |
| GET | `/api/v1/empresas/validar/:codigo` | público, limitado |
| GET | `/api/v1/empresas/perfil/:codigo` | público, limitado. Información del negocio con su foto, para clientes |
| GET | `/api/v1/empresas/actual` | sesión del personal |
| POST | `/api/v1/citas` | público, limitado. Invitado o cliente con sesión. Exige aceptar la política y los términos (ver "Reservas"). Solo de hoy a 14 días después (hora de Colombia) y dentro del horario de ese día. 403 si el teléfono está en la lista negra o el negocio está vencido; 409 si choca con un bloqueo |
| GET | `/api/v1/citas/ocupadas?empresaId=` | público (sin datos de clientes) |
| GET | `/api/v1/citas/bloqueos?empresaId=` | público. Horarios bloqueados del equipo, semanales y de una fecha (sin el motivo) |
| GET | `/api/v1/citas/agenda` | sesión del personal (admin: todo el negocio; empleado: sus citas), suscripción vigente |
| PATCH | `/api/v1/citas/:id/completar` | sesión del personal: el barbero de la cita, o la cuenta admin (cualquier cita del negocio), suscripción vigente |
| PATCH | `/api/v1/citas/:id/cancelar` | sesión del personal, solo admin del negocio, suscripción vigente (402 si no) |
| POST | `/api/v1/cuentas/registro/empresa` | público, limitado. Crea empresa + administrador. Exige aceptar la política y los términos |
| POST | `/api/v1/cuentas/registro/cliente` | público, limitado. Exige aceptar la política y los términos |
| POST | `/api/v1/cuentas/login` | público, limitado. Administradores de empresa y clientes (con correo) |
| GET | `/api/v1/admin/empresa/suscripcion` | personal admin (los dos tipos), **aunque esté vencida**. Estado, plan, fechas, días restantes y recordatorio |
| GET | `/api/v1/admin/empresa/prueba` | personal admin, aunque esté vencida (se mantiene; usa `/suscripcion`) |
| GET | `/api/v1/admin/empresa` | personal admin, aunque esté vencida ("Mi negocio") |
| PATCH | `/api/v1/admin/empresa` | personal admin, aunque esté vencida |
| PUT | `/api/v1/admin/empresa/foto` | personal admin, aunque esté vencida. Sube o cambia la foto del negocio |
| GET | `/api/v1/mi-cuenta/negocios` | cuenta de cliente. Negocios guardados |
| POST | `/api/v1/mi-cuenta/negocios` | cuenta de cliente, limitado. Guarda un negocio con su código |
| DELETE | `/api/v1/mi-cuenta/negocios/:id` | cuenta de cliente. Quita un negocio de la lista |
| GET | `/api/v1/mi-cuenta/citas` | cuenta de cliente. Citas que reservó con su sesión |
| GET | `/api/v1/clientes` | personal admin, suscripción vigente. Clientes del negocio |
| GET | `/api/v1/clientes/:id/historial` | personal admin, suscripción vigente |
| GET | `/api/v1/clientes/lista-negra` | personal admin, suscripción vigente |
| POST | `/api/v1/clientes/lista-negra` | personal admin, suscripción vigente |
| DELETE | `/api/v1/clientes/lista-negra/:id` | personal admin, suscripción vigente |
| GET | `/api/v1/equipo` | personal admin, suscripción vigente |
| POST | `/api/v1/equipo` | personal admin, suscripción vigente |
| PATCH | `/api/v1/equipo/:id` | personal admin, suscripción vigente |
| DELETE | `/api/v1/equipo/:id` | personal admin, suscripción vigente |
| PUT | `/api/v1/equipo/:id/foto` | personal admin, suscripción vigente |
| GET | `/api/v1/servicios` | personal admin, suscripción vigente |
| POST | `/api/v1/servicios` | personal admin, suscripción vigente |
| PATCH | `/api/v1/servicios/:id` | personal admin, suscripción vigente |
| DELETE | `/api/v1/servicios/:id` | personal admin, suscripción vigente |
| GET | `/api/v1/productos/catalogo/:codigo` | público, limitado. Catálogo para clientes |
| GET | `/api/v1/productos` | personal admin, suscripción vigente |
| POST | `/api/v1/productos` | personal admin, suscripción vigente |
| PATCH | `/api/v1/productos/:id` | personal admin, suscripción vigente |
| DELETE | `/api/v1/productos/:id` | personal admin, suscripción vigente |
| PUT | `/api/v1/productos/:id/foto` | personal admin, suscripción vigente |
| DELETE | `/api/v1/productos/:id/foto` | personal admin, suscripción vigente |
| GET | `/api/v1/bloqueos` | personal admin, suscripción vigente (los empleados no ven ni usan bloqueos) |
| POST | `/api/v1/bloqueos` | personal admin, suscripción vigente |
| DELETE | `/api/v1/bloqueos/:id` | personal admin, suscripción vigente |
| GET | `/api/v1/cartera?desde=&hasta=&barberoId=` | personal (admin: todo el negocio o un integrante; empleado: lo suyo), suscripción vigente |
| GET | `/api/v1/cartera/resumen?periodo=&desde=&hasta=&barberoId=` | personal (igual que `/cartera`), suscripción vigente. Resumen por período: `hoy`, `semana`, `mes` o `rango` |
| GET | `/uploads/empresas/<archivo>`, `/uploads/barberos/<archivo>`, `/uploads/productos/<archivo>` | público. La imagen guardada (se usa la dirección que devuelve la API) |

"Sesión del personal" acepta **dos tokens**: el del barbero (`/api/v1/auth/login`) y el de la **cuenta del administrador de la empresa** (`/api/v1/cuentas/login`, `rol = admin`). La cuenta admin cuenta como administrador del negocio (`esAdmin`), siempre de su propia empresa. "Personal admin" = integrante del equipo con rol Administrador (`esAdmin`) o cuenta admin: **los dos tienen los mismos permisos** sobre su empresa (Mi negocio, suscripción, equipo, servicios, productos, bloqueos, clientes y la cartera completa). Un **empleado** (integrante con rol Empleado) solo usa su agenda y su propia cartera. Detalle en "Gestión del negocio".

### Contrato de cuentas, prueba gratuita y administración

Hay dos tipos de sesión:

- **Personal** (`/api/v1/auth/login` o `/api/v1/login`, tabla `barberos`): sirve en `/empresas/actual`, `/citas/...` y los endpoints de gestión (`/clientes`, `/equipo`, `/servicios`, `/productos`, `/bloqueos`, `/cartera`). Un integrante con rol Administrador también sirve en `/api/v1/admin/empresa/...` (Mi negocio y suscripción); un empleado ahí responde 403 `Solo el administrador del negocio puede usar esta función.`
- **Cuenta** (`/api/v1/cuentas/...` o `/api/v1/login`, tabla `usuarios`, `rol` = `admin` | `cliente`): la cuenta **admin** sirve en `/api/v1/admin/...` y en todos los endpoints del personal, como administradora de su empresa. La de un **cliente** sirve en `/api/v1/mi-cuenta/...` y para reservar con su sesión; en los endpoints del personal y de `/api/v1/admin/...` responde 403 `Esta función es solo para el personal del negocio.`

Ambos se envían como `Authorization: Bearer <token>`.

**POST `/api/v1/login`** (login único): la administradora, alguien del personal o un **cliente con cuenta** entra con su **correo o usuario** y su contraseña; el backend detecta quién es. Los logins de antes (`/auth/login` y `/cuentas/login`) siguen funcionando igual.

- Recibe `{ "usuario": "ana.perez" | "ana@central.co", "clave": "…" }`. Si el texto tiene `@` se busca como correo (solo las cuentas tienen correo); si no, como usuario (no distingue mayúsculas). Un usuario nunca se repite entre cuentas (administradoras y clientes) y personal, así que no hay ambigüedad.
- Responde **200** con `tipo` y, según el caso, la misma respuesta del login de antes:
  - Administradora: `{ "tipo": "admin", "mensaje": "Autenticación exitosa", "token": "<jwt de cuenta>", "usuario": { "id", "correo", "usuario", "rol": "admin", "empresaId", "nombre": null, "telefono": null, "indicativo": null } }`
  - Cliente: `{ "tipo": "cliente", "mensaje": "Autenticación exitosa", "token": "<jwt de cuenta>", "usuario": { "id", "correo" | null, "usuario" | null, "rol": "cliente", "empresaId": null, "nombre", "telefono", "indicativo" }, "debeAceptarDocumentos": false }`. `debeAceptarDocumentos: true` = se publicó una versión nueva de la política o los términos y deberá aceptarla en su próxima reserva.
  - Personal: `{ "tipo": "personal", "mensaje": "Autenticación exitosa", "token": "<jwt del personal>", "barbero": { …igual que /auth/login… } }` (ahora incluye `rol` `"admin"` | `"empleado"` y `atiendeClientes`).
- Errores: **400** `Debes enviar tu correo o usuario y tu contraseña`; **401** `Correo, usuario o contraseña incorrectos` (igual si no existe); **402** `Este negocio está inactivo por ahora. Comunícate con el administrador del negocio.` (empleado de un negocio con la suscripción vencida; también en `/auth/login`); **429** demasiados intentos fallidos. Ya no responde 403 a los clientes.

**POST `/api/v1/cuentas/registro/empresa`**: registra la empresa, su horario y su administradora. La administradora entra después con su `correo` o su `usuario`, y la `clave`.

- Recibe:

  ```jsonc
  {
    "nombre": "Barbería Central",          // obligatorio, máx. 100
    "categoria": "Barbería",               // obligatorio, máx. 60
    "codigoAcceso": "central10",           // obligatorio: el código que usan los clientes (ver abajo)
    "direccion": "Calle 10 # 20-30",       // obligatorio, máx. 200
    "departamento": "Santander",           // obligatorio, departamento de Colombia
    "ciudad": "Bucaramanga",               // obligatorio, municipio de ese departamento
    "horario": [                           // obligatorio, los 7 días (ver abajo)
      { "dia": 0, "abierto": false },
      { "dia": 1, "abierto": true, "apertura": "08:00", "cierre": "19:00" },
      { "dia": 2, "abierto": true, "apertura": "08:00", "cierre": "19:00" },
      { "dia": 3, "abierto": true, "apertura": "08:00", "cierre": "19:00" },
      { "dia": 4, "abierto": true, "apertura": "08:00", "cierre": "19:00" },
      { "dia": 5, "abierto": true, "apertura": "08:00", "cierre": "20:00" },
      { "dia": 6, "abierto": true, "apertura": "09:00", "cierre": "14:00" }
    ],
    "nombreAdministradora": "Ana Pérez",   // obligatorio, máx. 120
    "numeroEmpleados": 4,                  // obligatorio, entero de 1 a 10
    "logoUrl": "https://cdn.central.co/logo.png", // opcional (o null); http:// o https://
    "correo": "ana@central.co",            // obligatorio: correo de inicio de sesión; único entre todas las cuentas
    "usuario": "ana.perez",                // obligatorio: 4 a 20, solo letras, números, punto y guion bajo; único (ver abajo)
    "clave": "clave-segura-123",           // obligatorio, 8 a 64 caracteres
    "aceptaPoliticaDatos": true,           // obligatorio: debe ser true (ver "Autorización de tratamiento de datos")
    "aceptaTerminos": true                 // obligatorio: debe ser true
  }
  ```

  - **Ya no existen** `nit`, `telefono` ni el correo de contacto del negocio (si llegan, se ignoran). `correo` ahora es solo el correo de inicio de sesión de la administradora.
  - **Código del negocio** (`codigoAcceso`): lo escribe la administradora. Solo letras (sin tildes ni ñ) y números, sin espacios, de 1 a 10 caracteres; no distingue mayúsculas (se guarda y se devuelve en mayúsculas: `central10` → `CENTRAL10`); no puede tenerlo otro negocio. Antes de enviar el formulario se puede revisar con `GET /api/v1/empresas/codigo-disponible/:codigo`.
  - **Usuario**: no puede repetirse con ninguna otra administradora ni con nadie del personal activo, sin distinguir mayúsculas (`Ana.Perez` = `ana.perez`). La base lo garantiza (índice único + trigger, migraciones 007 y 008). Lo mismo aplica al crear personal en `POST /equipo`: no puede usar el usuario de una administradora.
  - **Departamento y ciudad**: se validan con la lista oficial DIVIPOLA del DANE (`GET /api/v1/ubicaciones`). No distinguen tildes ni mayúsculas, y se guardan y devuelven con el nombre oficial en mayúsculas (`santander` / `bucaramanga` → `SANTANDER` / `BUCARAMANGA`). Se aceptan algunos nombres comunes: `Bogotá` (→ `BOGOTÁ, D.C.`), `Valle`, `San Andrés`, `Cartagena`, `Cúcuta`, `Tumaco`, `Buga`, `Mariquita`, `Ubaté`.
  - **Horario**: un elemento por cada día, `dia` de 0 (domingo) a 6 (sábado), cada día una sola vez. `abierto: false` = cerrado ese día (no lleva horas). Cada día abierto lleva `apertura` y `cierre` en HH:MM de 24 h, con el cierre posterior a la apertura. Al menos un día abierto. Las reservas respetan el horario de cada día.

- Responde **201**:

  ```json
  {
    "mensaje": "Empresa registrada. Tu prueba gratuita de 15 días comenzó hoy.",
    "token": "<jwt>",
    "usuario": { "id": "…", "correo": "ana@central.co", "usuario": "ana.perez", "rol": "admin", "empresaId": "…" },
    "empresa": {
      "id": "…", "nombre": "Barbería Central", "codigoAcceso": "CENTRAL10",
      "estadoSuscripcion": "trial", "trialEndsAt": "2026-11-02T18:00:00.000Z", "diasPruebaRestantes": 15
    }
  }
  ```

  `trialEndsAt` = momento del registro + 15 días.
- Errores: **400** dato faltante o inválido, por ejemplo:
  - `El campo "ciudad" es obligatorio`, `El correo no es válido`, `La contraseña debe tener entre 8 y 64 caracteres`
  - `El número de empleados debe ser un número entero entre 1 y 10`
  - `El usuario debe tener entre 4 y 20 caracteres: solo letras, números, punto y guion bajo`
  - `El código del negocio solo puede tener letras (sin tildes ni ñ) y números, sin espacios, máximo 10 caracteres`
  - `El departamento no es un departamento de Colombia`, `La ciudad no es un municipio de ese departamento`
  - `El campo "horario" es obligatorio`, `El horario debe traer los 7 días de la semana (0 = domingo … 6 = sábado), cada uno una sola vez`, `Indica en cada día del horario si está abierto ("abierto": true o false)`, `El martes está abierto: indica su hora de apertura y de cierre`, `El miércoles, la hora de cierre debe ser posterior a la de apertura`, `Las horas del horario deben tener el formato HH:MM (24 horas)`, `El negocio debe abrir al menos un día`

  - `Debes aceptar la Política de Tratamiento de Datos y los Términos y Condiciones` (falta `aceptaPoliticaDatos` o `aceptaTerminos`, o no es `true`)

  **409** `Ya existe una cuenta con ese correo`, `Ese usuario ya está en uso. Elige otro.` o `Ese código ya lo usa otro negocio. Elige otro.`; **429** demasiados registros.

**GET `/api/v1/empresas/codigo-disponible/:codigo`**: público (sin token), mismo límite por IP que `/empresas/validar/:codigo`.

- Responde **200** `{ "codigo": "CENTRAL10", "disponible": true }` (`codigo` normalizado en mayúsculas). `disponible: false` si ya lo tiene un negocio, incluido el propio (en "Mi negocio", enviar el mismo código de siempre no es un error).
- Errores: **400** `El código del negocio solo puede tener letras (sin tildes ni ñ) y números, sin espacios, máximo 10 caracteres`; **429**.

**GET `/api/v1/ubicaciones`**: público. **200** `[{ "codigo": "68", "nombre": "SANTANDER", "municipios": [{ "codigo": "68001", "nombre": "BUCARAMANGA" }, …] }, …]`: los 33 departamentos (incluye `BOGOTÁ, D.C.`) y sus 1122 municipios, ordenados por nombre. Envía `nombre` tal cual en el registro. La respuesta se puede guardar en caché un día.

**POST `/api/v1/cuentas/registro/cliente`**: crea una cuenta de cliente (sin empresa). Es opcional: se puede seguir reservando como invitado.

- Recibe:

  ```jsonc
  {
    "nombre": "Juan Gómez",        // obligatorio, máx. 100 (se usa al reservar)
    "telefono": "3001234567",      // obligatorio; se valida y se guarda en E.164 (ver "Teléfonos"); único entre las cuentas de cliente
    "indicativo": "57",            // opcional, por defecto 57 (Colombia)
    "correo": "juan@correo.com",   // correo o usuario (o los dos): con eso inicia sesión
    "usuario": "juan.gomez",       // mismas reglas y unicidad que el usuario de la administradora
    "clave": "clave-segura-123",   // 8 a 64 caracteres
    "aceptaPoliticaDatos": true,   // obligatorio: true
    "aceptaTerminos": true         // obligatorio: true
  }
  ```

- Responde **201** `{ "mensaje": "Cuenta creada", "token": "<jwt>", "usuario": { "id", "correo" | null, "usuario" | null, "rol": "cliente", "empresaId": null, "nombre", "telefono": "+573001234567", "indicativo": "57" } }`. Inicia sesión después con `/api/v1/login` (correo o usuario).
- Errores: **400** (`Envía tus datos para crear la cuenta` si no hay cuerpo, `El campo "nombre" es obligatorio`, `El campo "teléfono" es obligatorio`, el mensaje de teléfono inválido (ver "Teléfonos"), `Envía tu correo o un nombre de usuario para iniciar sesión`, `El correo no es válido`, el mensaje de usuario inválido, `La contraseña debe tener entre 8 y 64 caracteres`, `Debes aceptar la Política de Tratamiento de Datos y los Términos y Condiciones`); **409** `Ya existe una cuenta con ese correo`, `Ese usuario ya está en uso. Elige otro.` o `Ya existe una cuenta con ese número de teléfono`; **429**.

**POST `/api/v1/cuentas/login`**: login de administradoras y clientes con correo (se mantiene; para la administradora también sirve `/api/v1/login`).

- Recibe `{ "correo", "clave" }` (el correo no distingue mayúsculas).
- Responde **200** `{ "mensaje": "Autenticación exitosa", "token": "<jwt>", "usuario": { "id", "correo", "usuario", "rol", "empresaId", "nombre", "telefono", "indicativo" } }` (los clientes además llevan `debeAceptarDocumentos`). `usuario.rol` (`admin` o `cliente`) indica qué pantallas mostrar. Un cliente que se registró solo con usuario entra por `/api/v1/login`.
- Errores: **400** `Debes enviar correo y contraseña`; **401** `Correo o contraseña incorrectos` (igual si el correo no existe); **429**.

**GET `/api/v1/admin/empresa/suscripcion`** (los dos tipos de admin; responde aunque esté vencida): la suscripción de la empresa.

- Responde **200**:

  ```json
  { "estado": "activa", "plan": "mensual", "fechaPago": "2026-10-19", "fechaFin": "2026-11-19",
    "diasRestantes": 5, "diasPruebaSumados": null, "mostrarRecordatorio": true,
    "mensaje": "Te quedan 5 días de tu plan mensual. Renuévalo para no perder el acceso." }
  ```

- `estado`: `"prueba"` (15 días gratis desde el registro), `"activa"` (plan `"mensual"` o `"anual"`) o `"vencida"`.
- Si la empresa activó el plan **durante la prueba**, pasa de inmediato a `"activa"` y el plan empieza a contar desde el fin de la prueba. `diasPruebaSumados` = días de prueba que le quedaban y se sumaron al plan (`0` si pagó con la prueba ya vencida). `null` en la prueba o si el plan no se activó durante una prueba. Se conserva al renovar.
- `fechaPago` y `plan` son `null` en la prueba. `fechaFin` (AAAA-MM-DD) es el día en que termina la prueba o el plan. Las empresas activas de antes de los planes tienen `plan`, `fechaPago`, `fechaFin` y `diasRestantes` en `null` y no vencen.
- `diasRestantes` = `fechaFin` − hoy, con la **fecha actual de Colombia**: baja uno cada día a medianoche. El día de `fechaFin` ya es 0 y la suscripción queda **vencida**. Vencida = `0`.
- `mostrarRecordatorio`: `true` siempre durante la prueba y en los últimos 7 días de un plan (`diasRestantes` ≤ 7). `mensaje` es el texto para mostrar (o el aviso de vencida); `null` si no hay nada que mostrar.
- Los planes se activan con `npm run dev:activar-plan` (no hay pagos reales; ver "Comandos de desarrollador").

**Cuando la suscripción está vencida**:
- La administradora (cuenta o integrante admin) **puede iniciar sesión** y usar Mi negocio (`GET`/`PATCH /admin/empresa`, `PUT /admin/empresa/foto`) y la consulta de suscripción. Todo lo demás responde **402** (equipo, servicios, productos, bloqueos, clientes, cartera, agenda, completar y cancelar citas).
- Los **empleados** no pueden entrar: el login, la agenda, completar citas y la cartera responden **402** `Este negocio está inactivo por ahora. Comunícate con el administrador del negocio.` (`/empresas/actual` sigue respondiendo: es la misma información pública de `/empresas/validar/:codigo`).
- Los **clientes no pueden reservar**: `POST /citas` responde **403** `Este negocio no está recibiendo reservas por ahora`. `/empresas/validar/:codigo` (`empresa.recibiendoReservas`), `/empresas/perfil/:codigo` y `/mi-cuenta/negocios` traen `recibiendoReservas: false` para avisar antes.

**GET `/api/v1/admin/empresa/prueba`** (se mantiene para la app de antes; usa `/suscripcion`): días de prueba que le quedan a la empresa.

- Responde **200** `{ "estadoSuscripcion": "trial", "trialEndsAt": "<fecha ISO>", "diasRestantes": 12, "pruebaVencida": false }`.
- `diasRestantes` se cuenta igual que en `/suscripcion` (fecha de Colombia) y nunca es negativo; es `null` si la empresa no está en prueba (por ejemplo `"activa"`). Con la prueba vencida responde `diasRestantes: 0` y `pruebaVencida: true`.

**GET `/api/v1/admin/empresa`** ("Mi negocio"): perfil de la empresa del administrador (siempre la suya; no recibe id). Lo usan la cuenta admin y los integrantes con rol Administrador. `estadoSuscripcion` es el estado guardado; el estado real (con la fecha de fin) está en `/admin/empresa/suscripcion`.

- Responde **200** `{ "id", "nombre", "codigoAcceso", "categoria", "direccion", "departamento", "ciudad", "horario", "diasAtencion", "horarioApertura", "horarioCierre", "nombreAdministradora", "numeroEmpleados", "logoUrl", "fotoUrl", "colorPrimario", "colorSecundario", "latitud", "longitud", "googleMapsUrl", "estadoSuscripcion", "trialEndsAt", "creadaEn" }`.
- `latitud` y `longitud`: números o `null` (ubicación en el mapa, opcional). `googleMapsUrl`: enlace de Google Maps (ver "Ubicación en Google Maps").
- `horario` siempre trae los 7 días, de domingo (0) a sábado (6): `{ "dia": 0, "abierto": false, "apertura": null, "cierre": null }` o `{ "dia": 1, "abierto": true, "apertura": "08:00", "cierre": "19:00" }`.
- `diasAtencion` (días abiertos), `horarioApertura` (la apertura más temprana de la semana) y `horarioCierre` (el cierre más tardío) se calculan a partir de `horario` y se mantienen para que la app actual siga funcionando; para el horario real de cada día usa `horario`.
- Ya no incluye `nit`, `telefono` ni `correo`. `departamento` es `null` en empresas registradas antes de la migración 007 hasta que lo completen.
- `fotoUrl` es la dirección completa de la foto subida (ej. `https://api.mibarberia.co/uploads/empresas/<uuid>.jpg`) o `null` si no tiene. `logoUrl` es otro campo: una dirección web que el administrador escribe a mano.

**PATCH `/api/v1/admin/empresa`**: modifica la empresa del administrador.

- Recibe uno o más de: `nombre`, `categoria`, `codigoAcceso`, `direccion`, `departamento` + `ciudad` (siempre juntos), `horario` (los 7 días, reemplaza el horario completo), `nombreAdministradora`, `numeroEmpleados`, `logoUrl`, `latitud` + `longitud` (siempre juntas; números, `null` en las dos las quita). Mismas validaciones del registro. Se ignoran `id`, `empresaId`, `estadoSuscripcion`, `trialEndsAt`, `correo`, `usuario`, `clave` y cualquier otro campo (el acceso de la administradora no se cambia aquí).
- Cambiar `codigoAcceso` cambia el código que usan los clientes: el anterior deja de funcionar de inmediato.
- Responde **200** con el perfil actualizado (misma forma que el GET). Los datos y el horario se guardan juntos: si algo falla, no cambia nada.
- `numeroEmpleados` es el máximo de integrantes activos del equipo; no puede quedar por debajo del equipo activo actual.
- Errores: **400** `Envía al menos un dato para actualizar`, `Envía el departamento y la ciudad juntos`, `Envía la latitud y la longitud juntas (o las dos en null para quitarlas)`, `La latitud debe ser un número entre -90 y 90`, `La longitud debe ser un número entre -180 y 180` y los de validación del registro; **409** `Ese código ya lo usa otro negocio. Elige otro.` o `Tienes N integrante(s) activo(s) en el equipo. El número de empleados no puede ser menor; elimina primero del equipo a quien ya no trabaje en el negocio.`

**PUT `/api/v1/admin/empresa/foto`**: sube la foto del negocio o reemplaza la que tenía (la anterior se borra del servidor).

- Recibe `multipart/form-data` con **un solo** archivo en el campo `foto` y nada más. Solo JPG, PNG o WEBP, máximo 5 MB. El tipo se comprueba por el contenido del archivo, no por su nombre. Ejemplo en Expo:

  ```ts
  const datos = new FormData();
  datos.append('foto', { uri, name: 'foto.jpg', type: 'image/jpeg' } as any);
  await fetch(`${API}/api/v1/admin/empresa/foto`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` }, // no pongas Content-Type: fetch lo arma
    body: datos,
  });
  ```

- Responde **200** `{ "mensaje": "Foto del negocio actualizada", "fotoUrl": "https://…/uploads/empresas/<uuid>.jpg" }`.
- Errores: **400** `La foto debe ser una imagen JPG, PNG o WEBP` o `Envía la imagen en el campo "foto" (multipart/form-data)` (sin archivo, otro campo, más de un archivo o cuerpo mal formado); **413** `La foto no puede pesar más de 5 MB`; además los errores comunes de `/api/v1/admin/...` (401, 403, 402).
- La foto queda en `<CARPETA_SUBIDAS>/empresas/` con un nombre aleatorio; la base guarda solo la ruta (`/uploads/empresas/<uuid>.<ext>`, columna `empresas.foto_url`, migración 004). Para mostrarla usa `fotoUrl` tal cual.

**GET `/api/v1/empresas/perfil/:codigo`**: información del negocio para los clientes, con su foto. Público (sin token), usa el mismo código de acceso de `/empresas/validar/:codigo` y el mismo límite por IP.

- Responde **200** `{ "id", "nombre", "codigoAcceso", "categoria", "direccion", "departamento", "ciudad", "horario", "diasAtencion", "horarioApertura", "horarioCierre", "logoUrl", "fotoUrl", "colorPrimario", "colorSecundario", "googleMapsUrl", "recibiendoReservas" }` (`recibiendoReservas: false` si la suscripción venció), con `horario` y los campos calculados igual que en `GET /admin/empresa`. Ya no incluye `telefono` ni `correo`. No incluye nombre de la administradora, número de empleados ni datos de la suscripción. Los campos sin dato llegan como `null`.
- Errores: **404** `Establecimiento no encontrado`; **429** demasiados intentos.

**Ubicación en Google Maps** (`googleMapsUrl`, en `GET /empresas/perfil/:codigo` y en `GET`/`PATCH /admin/empresa`): enlace `https://www.google.com/maps/search/?api=1&query=...` (no necesita clave de API). Con las coordenadas si el negocio las tiene (`query=7.119349%2C-73.122741`); si no, con la dirección, el municipio y el departamento (`query=Calle%2010%20%23%2020-30%2C%20BUCARAMANGA%2C%20SANTANDER`). `null` si no hay ningún dato. Las coordenadas se editan en Mi negocio (`PATCH /admin/empresa` con `latitud` y `longitud`); no se piden en el registro.

**Errores comunes de `/api/v1/admin/...`**

- **401**: sin token o token vencido.
- **403** `Solo el administrador del negocio puede usar esta función.` (empleado) o `Esta función es solo para el personal del negocio.` (cliente).
- `/api/v1/admin/empresa/...` ya no responde 402: funciona con la suscripción vencida.

**Mensajes 402 (suscripción no vigente)** en los endpoints de gestión, la agenda y las citas:
  - prueba vencida: `Tu prueba gratuita de 15 días terminó. Activa tu suscripción para seguir usando las funciones de administrador.`
  - plan vencido o `vencida`: `La suscripción de tu empresa venció. Renuévala para seguir usando las funciones de administrador.`
  - `cancelada`: `La suscripción de tu empresa está cancelada. Actívala para seguir usando las funciones de administrador.`
  - a un empleado, siempre: `Este negocio está inactivo por ahora. Comunícate con el administrador del negocio.`

### Gestión del negocio (personal y cuenta del administrador)

Todos usan `Authorization: Bearer <token>` del barbero o de la cuenta admin. El negocio sale siempre de la sesión: nunca va en la URL ni en el cuerpo, y un `:id` de otro negocio responde 404.

**Errores comunes de estos endpoints**

- **401** `Sesión no válida. Inicia sesión de nuevo.` o `Sesión vencida. Inicia sesión de nuevo.`
- **403** `Esta función es solo para el personal del negocio.` (token de cliente) o `Solo el administrador del negocio puede usar esta función.` (empleado en un endpoint de admin).
- **402**: prueba gratuita o plan vencido, con los mensajes de "Mensajes 402". Aplica a todos estos endpoints (también a los empleados), menos a los públicos.
- **400** `Envía al menos un dato para actualizar` en un `PATCH` sin campos, y el mensaje de validación del campo (ej. `El campo "nombre" es obligatorio`).

**Permisos por rol**: la cuenta admin y los integrantes con rol Administrador pueden todo lo de esta sección. Un **empleado** solo puede `GET /citas/agenda` (sus citas), `PATCH /citas/:id/completar` (las suyas), `GET /cartera` (solo la suya) y `GET /empresas/actual`; en lo demás responde 403.

**Fotos de equipo y productos**: `PUT .../foto` recibe `multipart/form-data` con un solo archivo en el campo `foto`, igual que la foto del negocio: JPG, PNG o WEBP (se comprueba por el contenido), máximo 5 MB. Errores **400** `La foto debe ser una imagen JPG, PNG o WEBP` o `Envía la imagen en el campo "foto" (multipart/form-data)`; **413** `La foto no puede pesar más de 5 MB`. La foto anterior se borra del servidor. Los archivos quedan en `<CARPETA_SUBIDAS>/barberos/` o `<CARPETA_SUBIDAS>/productos/`; la API devuelve la dirección completa (`https://…/uploads/barberos/<uuid>.jpg`). Las fotos antiguas del equipo que ya eran direcciones web se devuelven tal cual. `/empresas/actual` y `/empresas/validar/:codigo` también devuelven `foto` del equipo como dirección completa. En esos dos, `empresa` trae además `horario` (los 7 días, misma forma que en `GET /admin/empresa`); `horarioApertura` y `horarioCierre` ahora son la apertura más temprana y el cierre más tardío de la semana.

#### Clientes (solo admin)

**GET `/api/v1/clientes`**: **200** clientes del negocio, del más reciente al más antiguo:

```json
[{ "id": "…", "nombre": "Juan", "telefono": "+573001234567", "indicativo": "57", "totalCitas": 4,
   "fechaUltimaCita": "2026-10-10", "enListaNegra": false, "listaNegraId": null }]
```

**GET `/api/v1/clientes/:id/historial`**: **200** `{ "cliente": { …misma forma que la lista… }, "citas": [{ "id", "fecha": "2026-10-10", "hora": "03:30 PM", "servicio", "barberoId", "barberoNombre", "precio": 25000, "estado": "COMPLETADA" }] }`, citas de la más reciente a la más antigua. **404** `Cliente no encontrado`.

**GET `/api/v1/clientes/lista-negra`**: **200** `[{ "id", "nombre", "telefono", "agregadoEn": "<fecha ISO>" }]`.

**POST `/api/v1/clientes/lista-negra`**: recibe `{ "clienteId": "…" }` y guarda el nombre y teléfono de ese cliente. **201** `{ "mensaje": "Cliente agregado a la lista negra", "id", "nombre", "telefono", "agregadoEn" }`. Errores: **400** `Envía el identificador del cliente en "clienteId"`; **404** `Cliente no encontrado`; **409** `Este cliente ya está en la lista negra`.

**DELETE `/api/v1/clientes/lista-negra/:id`** (`:id` = `id` de la lista negra, o `listaNegraId` del cliente): **200** `{ "mensaje": "Cliente quitado de la lista negra" }`. **404** `Ese registro no está en la lista negra`.

Un teléfono de la lista negra (se comparan solo los dígitos; los dos están en E.164) no puede reservar: `POST /api/v1/citas` responde **403** `No es posible agendar con este número. Comunícate con el negocio.`

#### Equipo (solo admin)

Forma de un profesional: `{ "id", "nombre", "usuario", "rol": "admin" | "empleado", "esAdmin": false, "atiendeClientes": true, "especialidad": "Barbero" | null, "porcentajeGanancia": 50, "foto": "<url>" | null }`.

- **Rol**: `"admin"` (Administrador: los mismos permisos que la cuenta admin) o `"empleado"` (Empleado: solo su agenda y su cartera). `esAdmin` se mantiene igual a `rol === "admin"`.
- **Atiende clientes** (`atiendeClientes`): si recibe reservas como profesional. Quien no atiende no aparece en la vista pública del negocio (`/empresas/validar/:codigo`) y no se puede reservar con él (`POST /citas` responde 404 `Servicio o profesional no encontrado`). En `/empresas/actual` aparecen todos, con `atiendeClientes`.
- **Límite**: no puede haber más integrantes activos que el `numeroEmpleados` de la empresa (máximo 10; las empresas sin ese dato tienen 10). Los eliminados no cuentan. Si un negocio ya tenía más, conserva su equipo pero no puede agregar a nadie hasta quedar por debajo.

**GET `/api/v1/equipo`**: **200** lista del equipo activo.

**POST `/api/v1/equipo`**: recibe

```jsonc
{
  "nombre": "Carlos",            // obligatorio, máx. 100
  "usuario": "carlos.r",         // obligatorio, 3 a 60: letras, números, . _ -; único (sin distinguir mayúsculas)
  "clave": "clave-segura",       // obligatorio, 8 a 64 caracteres; con ella entra en /api/v1/auth/login
  "rol": "empleado",             // opcional: "admin" (Administrador) o "empleado" (Empleado, por defecto)
  "esAdmin": false,              // opcional, se mantiene para la app de antes; si llega "rol", manda "rol"
  "atiendeClientes": true,       // opcional; por defecto true para un empleado y false para un administrador
  "especialidad": "Barbero",     // opcional (o null), máx. 100
  "porcentajeGanancia": 50       // opcional, 0 a 100, por defecto 50
}
```

**201** con el profesional. Errores: **400** validación (ej. `La contraseña debe tener entre 8 y 64 caracteres`, `El rol debe ser "admin" (Administrador) o "empleado" (Empleado)`); **409** `Ese usuario ya está en uso. Elige otro.` (también si es el usuario de una administradora o de un cliente) o, con el equipo lleno, `Tu equipo ya tiene 2 integrante(s) activo(s) y registraste 2 empleado(s). Para agregar a alguien más, aumenta el número de empleados en Mi negocio (máximo 10).` (con 10: `Tu equipo ya tiene 10 integrantes activos, el máximo permitido (10).`)

**PATCH `/api/v1/equipo/:id`**: uno o más campos del POST (`rol` cambia el rol, `atiendeClientes` activa o quita las reservas, `clave` cambia la contraseña; `especialidad: null` la quita). **200** con el profesional. Errores: **400** `No puedes quitarte a ti mismo el rol de administrador.`; **404** `Profesional no encontrado`; **409** usuario repetido.

**DELETE `/api/v1/equipo/:id`**: **200** `{ "mensaje": "Profesional eliminado" }`. Ya no inicia sesión ni recibe reservas; sus citas pasadas y la cartera lo siguen mostrando. Errores: **400** `No puedes eliminar tu propio usuario.`; **404** `Profesional no encontrado`; **409** `Este profesional tiene N cita(s) pendiente(s). Cancélalas antes de eliminarlo.`

**PUT `/api/v1/equipo/:id/foto`** (multipart, campo `foto`): **200** `{ "mensaje": "Foto del profesional actualizada", "foto": "<url>" }`. **404** `Profesional no encontrado`.

#### Servicios

Forma: `{ "id", "nombre", "duracionMin": 30, "duracion": "30 min", "precio": 25000 }`.

**GET `/api/v1/servicios`** (admin): **200** servicios activos.

**POST `/api/v1/servicios`** (admin): recibe `{ "nombre": "Corte", "duracionMin": 30, "precio": 25000 }`, todos obligatorios: `nombre` máx. 100; `duracionMin` entero de 1 a 1440; `precio` 0 o más, máximo 2 decimales. **201** con el servicio.

**PATCH `/api/v1/servicios/:id`** (admin): uno o más de esos campos. **200** con el servicio. Las citas ya agendadas conservan su precio y duración. **404** `Servicio no encontrado`.

**DELETE `/api/v1/servicios/:id`** (admin): **200** `{ "mensaje": "Servicio eliminado" }`. Deja de ofrecerse; las citas pasadas lo siguen mostrando. **404** `Servicio no encontrado`.

#### Productos

Forma: `{ "id", "nombre", "descripcion": "…" | null, "precio": 30000, "fotoUrl": "<url>" | null }`.

**GET `/api/v1/productos/catalogo/:codigo`** (público, sin token; mismo código y límite por IP que `/empresas/validar/:codigo`): **200** productos del negocio (puede ser `[]`). **404** `Establecimiento no encontrado`; **429**.

**GET `/api/v1/productos`** (admin): **200** productos del negocio.

**POST `/api/v1/productos`** (admin): recibe `{ "nombre": "Cera", "precio": 30000, "descripcion": "Fijación fuerte" }`: `nombre` obligatorio (máx. 100), `precio` obligatorio (0 o más, máx. 2 decimales), `descripcion` opcional o null (máx. 500). **201** con el producto, sin foto. La foto (opcional) se agrega después con `PUT /productos/:id/foto`.

**PATCH `/api/v1/productos/:id`** (admin): uno o más de esos campos (`descripcion: null` la quita). **200** con el producto. **404** `Producto no encontrado`.

**DELETE `/api/v1/productos/:id`** (admin): **200** `{ "mensaje": "Producto eliminado" }`; también borra su foto. **404** `Producto no encontrado`.

**PUT `/api/v1/productos/:id/foto`** (admin, multipart, campo `foto`): **200** `{ "mensaje": "Foto del producto actualizada", "fotoUrl": "<url>" }`. **404** `Producto no encontrado`.

**DELETE `/api/v1/productos/:id/foto`** (admin): **200** `{ "mensaje": "Foto del producto eliminada", "fotoUrl": null }`. **404** `Producto no encontrado`.

#### Bloqueos de horario (semanales y de solo ese día)

**Solo la administradora** (integrante admin o cuenta admin) ve, crea y borra bloqueos. Los empleados no ven ni usan bloqueos (403). Hay dos tipos:

- **Semanal** (`tipo: "semanal"`): se repite cada semana el mismo día (ej. almuerzo de los lunes). Lleva `diaSemana` (0 = domingo … 6 = sábado) y `fecha: null`.
- **Solo ese día** (`tipo: "fecha"`): una fecha concreta. Lleva `fecha` (AAAA-MM-DD) y `diaSemana: null`.

Cualquiera de los dos puede ser de unas horas (`horaInicio`–`horaFin`) o del **día completo** (`todoElDia: true`, que se guarda y se devuelve como `"00:00"`–`"24:00"`).

Forma: `{ "id", "barberoId", "barberoNombre", "tipo": "semanal" | "fecha", "diaSemana": 1 | null, "fecha": "2026-10-21" | null, "todoElDia": false, "horaInicio": "12:00", "horaFin": "13:00", "motivo": "Almuerzo" | null }`.

**GET `/api/v1/bloqueos`** (solo admin): **200** lista: los semanales y los de fecha de hoy en adelante (hora de Colombia), de todo el equipo (opcional `?barberoId=` para filtrar).

**POST `/api/v1/bloqueos`** (solo admin): recibe uno de estos cuerpos (`motivo` opcional, máx. 200):

```jsonc
{ "barberoId": "…", "diaSemana": 1, "horaInicio": "12:00", "horaFin": "13:00", "motivo": "Almuerzo" } // semanal
{ "barberoId": "…", "fecha": "2026-10-21", "horaInicio": "10:00", "horaFin": "11:00" }            // unas horas de ese día
{ "barberoId": "…", "fecha": "2026-10-22", "todoElDia": true, "motivo": "Vacaciones" }          // ese día completo
```

Horas HH:MM de 24 h, fin posterior al inicio; con `todoElDia: true` las horas se ignoran. **201** con el bloqueo. Errores: **400** `Elige el profesional en "barberoId"`, `Envía "diaSemana" para un bloqueo que se repite cada semana, o "fecha" para un bloqueo de solo ese día (solo uno de los dos)`, `Envía "horaInicio" y "horaFin", o "todoElDia": true para bloquear el día completo`, `La hora de fin debe ser posterior a la hora de inicio`, `El campo "fecha" debe ser una fecha real con el formato AAAA-MM-DD`, `El día debe ser un número del 0 (domingo) al 6 (sábado)`; **403** `Solo el administrador del negocio puede usar esta función.` (barbero sin `esAdmin`); **404** `Profesional no encontrado`.

**DELETE `/api/v1/bloqueos/:id`** (solo admin): **200** `{ "mensaje": "Bloqueo eliminado" }`. **403** `Solo el administrador del negocio puede usar esta función.`; **404** `Bloqueo no encontrado`.

**GET `/api/v1/citas/bloqueos?empresaId=`** (público, para la pantalla de reservar): **200** los dos tipos, **sin el motivo**: `[{ "barberoId", "tipo": "semanal", "diaSemana": 1, "fecha": null, "todoElDia": false, "horaInicio": "12:00", "horaFin": "13:00" }, { "barberoId", "tipo": "fecha", "diaSemana": null, "fecha": "2026-10-22", "todoElDia": true, "horaInicio": "00:00", "horaFin": "24:00" }]`. Los de fecha solo de hoy en adelante (hora de Colombia). Una reserva que cae en cualquier bloqueo responde **409** `El profesional no atiende en ese horario. Por favor elige otra hora.`

#### Reservas (`POST /api/v1/citas`)

Cuerpo: `{ "empresaId", "barberoId", "servicioId", "fecha": "2026-10-21", "hora": "10:00 AM", "nombre", "telefono", "indicativo"?, "aceptaPoliticaDatos": true, "aceptaTerminos": true }`.

El teléfono se valida y se guarda en E.164 (ver "Teléfonos"); la respuesta trae `cita.telefono` en E.164 (`"+573001234567"`) y `cita.indicativo`. El cliente del negocio es el mismo si el número es el mismo, aunque se escriba distinto (`300 123 4567`, `+57 3001234567`).

- **Como invitado** (sin token; con código, enlace o QR): igual que antes, más la aceptación. `nombre` y `telefono` son obligatorios (**400** `Faltan datos para agendar la cita`) y `aceptaPoliticaDatos` y `aceptaTerminos` deben ser `true` en cada reserva (**400** `Debes aceptar la Política de Tratamiento de Datos y los Términos y Condiciones`). Se guarda la prueba con el teléfono.
- **Con sesión de cliente** (`Authorization: Bearer <token de la cuenta del cliente>`): se usan el nombre, teléfono e indicativo de la cuenta (lo que llegue en el cuerpo se ignora; una cuenta antigua sin esos datos usa los del cuerpo). No vuelve a aceptar: solo si se publicó una versión nueva de la política o los términos desde que aceptó, debe enviar los dos en `true` (**400** `Publicamos una nueva versión de la Política de Tratamiento de Datos o de los Términos y Condiciones. Acéptala para continuar.`). La cita queda en "Mis citas" (`GET /mi-cuenta/citas`).
- Cualquier otro token (personal, admin o vencido) se ignora: la reserva es de invitado.
- Negocio con la suscripción vencida: **403** `Este negocio no está recibiendo reservas por ahora`.
- Solo con profesionales que atienden clientes (`atiendeClientes`); si no, **404** `Servicio o profesional no encontrado`.

Además de las reglas de siempre (lista negra, bloqueos, choque con otra cita), una reserva debe cumplir:

- **Fecha**: desde hoy hasta 14 días después (15 días en total contando hoy), en hora de Colombia (`America/Bogota`). Errores **400** `No se pueden agendar citas en fechas pasadas` o `Solo puedes reservar desde hoy hasta 14 días después (hasta el 2026-11-02).` (con la fecha límite real).
- **Horario de ese día** (el `horario` del negocio): **400** `El negocio no atiende ese día. Por favor elige otra fecha.` si ese día está cerrado, o `La hora elegida está fuera del horario del negocio` si la cita empieza antes de la apertura o termina después del cierre de ese día.

#### Cartera

**GET `/api/v1/cartera?desde=2026-10-01&hasta=2026-10-31&barberoId=`** (personal). Un admin ve todo el negocio, o un integrante con `barberoId` (también el suyo, si es integrante del equipo). Un empleado ve solo lo suyo (su `barberoId` se ignora si envía otro). La respuesta trae `barberoId` (el filtro aplicado; `null` = todo el negocio). Suma las citas **completadas** con fecha entre `desde` y `hasta` (incluidas). La ganancia de cada cita usa el porcentaje que tenía el profesional **cuando se completó** (se guarda en `citas.porcentaje_ganancia`, migración 006); cambiar después su porcentaje no cambia lo que ya ganó. El negocio se queda con el resto. En `porProfesional`, `porcentajeGanancia` es el porcentaje **actual** del profesional (informativo); `ganancia` puede no coincidir con `ventas × porcentajeGanancia` si el porcentaje cambió dentro del rango. Las citas completadas antes de la migración 006 tomaron el porcentaje que el profesional tenía ese día.

```json
{
  "desde": "2026-10-01", "hasta": "2026-10-31", "barberoId": null,
  "totalCitas": 42, "totalVentas": 1050000, "gananciaEquipo": 525000, "gananciaNegocio": 525000,
  "porProfesional": [
    { "barberoId": "…", "nombre": "Carlos", "activo": true, "porcentajeGanancia": 50,
      "citas": 20, "ventas": 500000, "ganancia": 250000 }
  ]
}
```

Errores: **400** `El campo "desde" es obligatorio`, `El campo "desde" debe ser una fecha real con el formato AAAA-MM-DD`, `La fecha "hasta" no puede ser anterior a "desde"`, `El rango no puede ser mayor que 366 días` o `Identificador de profesional inválido`.

**GET `/api/v1/cartera/resumen?periodo=mes`** (personal, suscripción vigente): resumen de un período. Mismas reglas de acceso que `/cartera` (un admin ve todo el negocio o un integrante con `barberoId`; un empleado solo lo suyo).

- `periodo` (obligatorio): `hoy`; `semana` (de lunes a domingo de esta semana); `mes` (del día 1 al último día de este mes); o `rango` con `desde` y `hasta` (AAAA-MM-DD, máximo 366 días). Fechas de Colombia.
- Responde **200**, con los profesionales de mayor a menor en ventas:

  ```json
  {
    "periodo": "mes", "desde": "2026-10-01", "hasta": "2026-10-31", "barberoId": null,
    "totalVentas": 60000, "gananciaNegocio": 32000, "citasCompletadas": 3,
    "porProfesional": [
      { "barberoId": "…", "nombre": "Carlos", "activo": true, "citas": 2, "ventas": 40000, "ganancia": 20000 },
      { "barberoId": "…", "nombre": "Luis", "activo": true, "citas": 1, "ventas": 20000, "ganancia": 8000 }
    ]
  }
  ```

  `ganancia` es lo que ganó el profesional (con el porcentaje guardado en cada cita, igual que `/cartera`); `gananciaNegocio` = `totalVentas` − lo que ganó el equipo.
- Errores: **400** `Elige el período en "periodo": "hoy", "semana", "mes" o "rango" (con "desde" y "hasta")`, y con `rango` los mismos de `/cartera` (`El campo "desde" es obligatorio`, …).

### Teléfonos (formato E.164)

- Todos los teléfonos que recibe el backend (reservas `POST /citas` y cuentas de cliente `POST /cuentas/registro/cliente`) se validan y normalizan con **libphonenumber-js** (`src/shared/telefonos.ts`) y se guardan en **E.164** (`+573162781393`, máx. 16 caracteres). El equipo no tiene teléfono.
- Se acepta el número como lo escriba la persona: con espacios o guiones, con `+` y código de país (`+57 316 278 1393`), con el indicativo pegado (`573162781393`) o sin código de país; **sin código de país se usa `indicativo`, y si no llega, Colombia (57)**. El `indicativo` que se guarda y se devuelve es el del número.
- Inválido → **400** `El número de teléfono no es válido. Revisa el número y el indicativo del país (ej. 3001234567 para Colombia).`
- Unicidad: único **por negocio** en los clientes de cada empresa y **único global** entre las cuentas de cliente (**409** `Ya existe una cuenta con ese número de teléfono`). En las demás tablas no es único global.
- Los teléfonos guardados antes de la migración 011 que no se pudieron convertir siguen en la base con solo sus dígitos (no empiezan con `+`); ver la migración 011 en "Base de datos y entorno".

### Cuenta del cliente (`/api/v1/mi-cuenta`)

Solo con el token de una cuenta de cliente (`/api/v1/login` o `/cuentas/login`). Otro token responde **403** `Esta función es solo para clientes con cuenta.` (cuenta admin) o **401** (personal, sin token o vencido).

Forma de un negocio guardado: `{ "id", "nombre", "codigoAcceso", "categoria", "direccion", "departamento", "ciudad", "logoUrl", "fotoUrl", "recibiendoReservas": true, "guardadoEn": "<fecha ISO>" }`. Se guarda el negocio, no el código: si el negocio cambia su código, sigue en la lista con el nuevo.

- **GET `/mi-cuenta/negocios`**: **200** negocios guardados, del más reciente al más antiguo.
- **POST `/mi-cuenta/negocios`**: recibe `{ "codigo": "central10" }`. **201** `{ "mensaje": "Negocio guardado", "negocio": { … } }` (si ya estaba, responde igual). Errores: **400** `Envía el código del negocio en "codigo"` o el mensaje del código inválido; **404** `Establecimiento no encontrado`; **429** (mismo límite que `/empresas/validar/:codigo`).
- **DELETE `/mi-cuenta/negocios/:id`** (`:id` = `id` del negocio): **200** `{ "mensaje": "Negocio quitado de tu lista" }`. **404** `Ese negocio no está en tu lista`.
- **GET `/mi-cuenta/citas`**: **200** citas que reservó con su sesión, de la más reciente a la más antigua: `[{ "id", "empresaId", "negocio", "codigoAcceso", "servicio", "barberoId", "barberoNombre", "fecha": "2026-10-21", "hora": "10:00 AM", "duracionMin": 30, "precio": 25000, "estado": "CONFIRMADA" }]`. Las reservas como invitado no aparecen.

### Autorización de tratamiento de datos (Ley 1581 de 2012)

- El registro de empresa, el registro de cliente y la reserva como invitado exigen `"aceptaPoliticaDatos": true` y `"aceptaTerminos": true`; si no, **400** `Debes aceptar la Política de Tratamiento de Datos y los Términos y Condiciones`. Un cliente con cuenta solo acepta de nuevo cuando se publica una versión nueva (ver "Reservas").
- La app muestra los textos vigentes con **GET `/api/v1/legal/politica-datos`** y **GET `/api/v1/legal/terminos`** (públicos): **200** `{ "tipo": "politica_datos" | "terminos", "version": "0.1-borrador", "titulo", "contenido": "<markdown>", "publicadoEn": "<fecha ISO>" }`.
- **Los textos actuales son un BORRADOR – PENDIENTE DE REVISIÓN LEGAL** (migración 010), solo para pruebas. Tienen espacios por llenar como `[NOMBRE DEL RESPONSABLE]`, `[NIT]`, `[CORREO DE CONTACTO]` y `[DIRECCIÓN]`. No publiques la app con usuarios reales hasta que un abogado los revise y se publique una versión nueva.
- Prueba de cada autorización en `autorizaciones_datos`: `origen` (`registro_empresa`, `registro_cliente` o `reserva`), quién (`usuario_id`, o `telefono` + `indicativo` si es invitado), `empresa_id` y `cita_id` cuando aplica, `aceptado_en` (fecha y hora) y `version_politica` / `version_terminos` aceptadas. Se acepta siempre la política y los términos juntos. Se borra con la cuenta o el negocio al que pertenece.

## Autenticación y roles

- Personal: login con `usuario` + `clave` contra `barberos` activos (bcrypt, costo 12). El token lleva `sub` (id del barbero) y `empresaId`. `requerirSesion` **lee `es_admin` de la base en cada solicitud**, así que un cambio de rol aplica de inmediato; `requerirAdmin` exige admin. Un barbero eliminado (`activo = false`) pierde la sesión. Rol en la API: `es_admin` true = `"admin"`, false = `"empleado"`.
- `requerirSesion` también acepta el token de una cuenta `admin`: la sesión queda con `usuarioId`, `barberoId: null`, la empresa de la cuenta y `esAdmin: true` (`src/modules/auth/auth.servicio.ts`). Si la cuenta completó o canceló una cita, queda en `citas.completada_por_usuario` / `cancelada_por_usuario` (migración 005). `crearPermisos` (`src/modules/auth/permisos.ts`) arma las guardias `personal` y `admin` de los módulos de gestión; ambas exigen suscripción vigente.
- Login único (`POST /api/v1/login`, `src/modules/auth/acceso.ts`): con `@` busca la cuenta (admin o cliente) por correo; sin `@`, primero la cuenta por `usuarios.usuario` y si no existe, el personal por `barberos.usuario`. Firma el mismo token que el login de antes de cada tipo, así que las guardias no cambian. Hace siempre una comparación bcrypt, para que el tiempo no revele qué correos o usuarios existen.
- Usuario de la administradora (`usuarios.usuario`, migración 007): obligatorio para `rol = admin`, `null` en clientes, único sin distinguir mayúsculas. El trigger `verificar_usuario_login_unico` (corregido en la 008) impide que coincida con un barbero activo y al revés. A las administradoras que ya existían se les creó a partir de su correo (lo que va antes de la @; si se repetía, con un número al final).
- Cuentas: login con `correo` + `clave` contra `usuarios` (bcrypt, costo 12). El token lleva `sub` (id del usuario) y `tipo: "cuenta"`. `requerirCuenta` **lee `rol` y `empresa_id` de la base en cada solicitud**; `requerirAdminEmpresa` exige `rol = admin` con empresa (`src/modules/cuentas/cuentas.guardias.ts`).
- Los tokens son JWT HS256 y duran `JWT_EXPIRA_EN`.
- Cuentas de cliente: `rol = cliente`, sin empresa, con `nombre`, `telefono`, `indicativo` y correo o usuario (los dos opcionales, al menos uno). `cuentas.clienteDeToken` reconoce su token en `POST /citas`; `requerirCuenta` + `requerirCliente` protegen `/mi-cuenta`.
- Suscripción (`src/modules/empresas/suscripcion.ts`, `buscarSuscripcion` en `empresas.repositorio.ts`): el estado se **calcula** en cada consulta con la fecha de Colombia, sin tareas programadas. Fin = día de `trial_ends_at` (prueba) o `suscripcion_fin` (plan); habilitada si el estado guardado es `trial` o `activa` y el fin es posterior a hoy (o `activa` sin fin, empresas de antes de los planes, que quedaron `activa`). `requerirSuscripcionVigente` va después de la guardia de sesión en los endpoints de gestión, agenda y citas, y responde 402 (mensaje de negocio inactivo a los empleados). Mi negocio y `/suscripcion` no la llevan.

## Reglas de seguridad (auditoría previa)

- Negocio, usuario y rol salen **de la sesión**, nunca del cuerpo ni de la URL.
- Toda entrada se valida con zod en la capa de rutas (`parsear`); el cuerpo JSON tiene un límite de 10 kb.
- SQL siempre parametrizado (`$1`, `$2`…). Nunca concatenes valores del usuario.
- Las consultas usan listas explícitas de columnas: nada de `SELECT *`, para no filtrar `password_hash`, datos de clientes ni columnas nuevas.
- Errores siempre como `{ "error": "mensaje" }`, sin pila ni SQL; el detalle queda solo en el log del servidor (`shared/http/manejadorErrores.ts`).
- Integridad en la base: llaves foráneas compuestas `(empresa_id, …)` aíslan negocios; `citas_sin_solapamiento` impide dobles reservas (la API responde 409); CHECK en estados, horarios y precios.
- Límites por IP (login, código de negocio, reservas, registro, general), `helmet` y CORS con lista de orígenes.
- Prueba cada regla nueva con un test de integración en `test/`.
