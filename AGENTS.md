# AGENTS.md — agendamiento-backend

API REST (Express 5 + TypeScript + PostgreSQL) para agendar citas en barberías. Varios negocios comparten la base; cada uno solo ve sus datos. Detalle completo en `README.md`.

**Este repositorio es solo el backend.** El frontend (Expo/React Native) está en `C:\Users\eduar_9\app`; no lo modifiques desde aquí.

## Estructura

```
src/
  server.ts          arranque y apagado ordenado
  app.ts             crea servicios y conecta rutas (recibe pool y entorno)
  config/entorno.ts  variables de entorno validadas con zod
  db/                pool, migraciones (migrar.ts) y scripts de mantenimiento
  shared/            errores, logs JSON, middlewares HTTP (CORS, límites, validación, errores)
  modules/<modulo>/  auth, cuentas, empresas, citas, clientes, equipo, servicios, productos, bloqueos, cartera: <m>.rutas.ts (HTTP + zod) → <m>.servicio.ts (reglas) → <m>.repositorio.ts (SQL)
db/migraciones/      SQL numerado NNN_nombre.sql; cada archivo en su propia transacción
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

Puerto por defecto `4000` (`PORT`). Rutas bajo `/api/v1`.

## Base de datos y entorno

- PostgreSQL vía `pg` (`src/db/pool.ts`), con las extensiones `btree_gist` (migración 002) y `gen_random_uuid()` (PostgreSQL 13 o superior).
- Variables en `.env` en la raíz (ignorado por git; nunca lo subas). Se validan al arrancar en `src/config/entorno.ts`: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_MAX`, `JWT_SECRET`, `JWT_EXPIRA_EN`, `CORS_ORIGINS`, `TRUST_PROXY`, `NODE_ENV`, `PORT`, `CARPETA_SUBIDAS` (opcional, por defecto `uploads`: carpeta de las fotos subidas, ignorada por git) y `URL_PUBLICA` (opcional: dirección pública del servidor, ej. `https://api.mibarberia.co`, para armar las URL de las fotos; si falta se usa la dirección de cada solicitud, así que configúrala en producción).
- El esquema solo cambia con un archivo nuevo en `db/migraciones/` (siguiente número). Nunca edites una migración ya aplicada.

## Endpoints

Todas las respuestas son JSON. Los errores siempre llegan como `{ "error": "mensaje" }`, listo para mostrar al usuario.

| Método | Ruta | Acceso |
| --- | --- | --- |
| GET | `/api/saludo` | público (salud) |
| POST | `/api/v1/auth/login` | público, limitado. Personal (barberos). Cuerpo `{ usuario, clave }` |
| GET | `/api/v1/empresas/validar/:codigo` | público, limitado |
| GET | `/api/v1/empresas/perfil/:codigo` | público, limitado. Información del negocio con su foto, para clientes |
| GET | `/api/v1/empresas/actual` | sesión del personal |
| POST | `/api/v1/citas` | público, limitado. 403 si el teléfono está en la lista negra; 409 si choca con un bloqueo |
| GET | `/api/v1/citas/ocupadas?empresaId=` | público (sin datos de clientes) |
| GET | `/api/v1/citas/bloqueos?empresaId=` | público. Horarios bloqueados del equipo (sin el motivo) |
| GET | `/api/v1/citas/agenda` | sesión del personal (admin: todo el negocio; barbero: sus citas) |
| PATCH | `/api/v1/citas/:id/completar` | sesión del personal: el barbero de la cita, o la cuenta admin (cualquier cita del negocio) |
| PATCH | `/api/v1/citas/:id/cancelar` | sesión del personal, solo admin del negocio, suscripción vigente (402 si no) |
| POST | `/api/v1/cuentas/registro/empresa` | público, limitado. Crea empresa + administrador |
| POST | `/api/v1/cuentas/registro/cliente` | público, limitado |
| POST | `/api/v1/cuentas/login` | público, limitado. Administradores de empresa y clientes |
| GET | `/api/v1/admin/empresa/prueba` | cuenta admin (responde aunque la prueba haya vencido) |
| GET | `/api/v1/admin/empresa` | cuenta admin, suscripción vigente |
| PATCH | `/api/v1/admin/empresa` | cuenta admin, suscripción vigente |
| PUT | `/api/v1/admin/empresa/foto` | cuenta admin, suscripción vigente. Sube o cambia la foto del negocio |
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
| GET | `/api/v1/servicios` | personal (cualquiera), suscripción vigente |
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
| GET | `/api/v1/bloqueos` | personal (admin: todo el equipo; barbero: los suyos), suscripción vigente |
| POST | `/api/v1/bloqueos` | personal (admin: cualquier barbero; barbero: el suyo), suscripción vigente |
| DELETE | `/api/v1/bloqueos/:id` | personal (admin: cualquiera; barbero: los suyos), suscripción vigente |
| GET | `/api/v1/cartera?desde=&hasta=` | personal (admin: todo el negocio; barbero: lo suyo), suscripción vigente |
| GET | `/uploads/empresas/<archivo>`, `/uploads/barberos/<archivo>`, `/uploads/productos/<archivo>` | público. La imagen guardada (se usa la dirección que devuelve la API) |

"Sesión del personal" acepta **dos tokens**: el del barbero (`/api/v1/auth/login`) y el de la **cuenta del administrador de la empresa** (`/api/v1/cuentas/login`, `rol = admin`). La cuenta admin cuenta como administrador del negocio (`esAdmin`), siempre de su propia empresa. "Personal admin" = barbero con `esAdmin` o cuenta admin. Detalle en "Gestión del negocio".

### Contrato de cuentas, prueba gratuita y administración

Hay dos tipos de sesión:

- **Personal** (`/api/v1/auth/login`, tabla `barberos`): sirve en `/empresas/actual`, `/citas/...` y los endpoints de gestión (`/clientes`, `/equipo`, `/servicios`, `/productos`, `/bloqueos`, `/cartera`). En `/api/v1/admin/...` responde 401.
- **Cuenta** (`/api/v1/cuentas/...`, tabla `usuarios`, `rol` = `admin` | `cliente`): sirve en `/api/v1/admin/...`. La cuenta **admin** también sirve en todos los endpoints del personal, como administradora de su empresa. La de un **cliente** responde 403 `Esta función es solo para el personal del negocio.` en los endpoints del personal.

Ambos se envían como `Authorization: Bearer <token>`.

**POST `/api/v1/cuentas/registro/empresa`**: registra la empresa y su administrador. El administrador entra después con el `correo` de la empresa y la `clave`.

- Recibe:

  ```jsonc
  {
    "nombre": "Barbería Central",          // obligatorio, máx. 100
    "categoria": "Barbería",               // obligatorio, máx. 60
    "nit": "900123456-7",                  // opcional (o null); números, espacios y guiones; único
    "telefono": "3001234567",              // obligatorio, 7 a 20: números, espacios, ( ) - +
    "correo": "admin@central.co",          // obligatorio, correo válido; único entre todas las cuentas
    "direccion": "Calle 10 # 20-30",       // obligatorio, máx. 200
    "ciudad": "Bucaramanga",               // obligatorio, máx. 100
    "diasAtencion": [1, 2, 3, 4, 5, 6],    // obligatorio, 0 = domingo … 6 = sábado, sin repetir
    "horarioApertura": "08:00",            // obligatorio, HH:MM 24 h
    "horarioCierre": "19:00",              // obligatorio, HH:MM 24 h, posterior a la apertura
    "nombreAdministradora": "Ana Pérez",   // obligatorio, máx. 120
    "numeroEmpleados": 4,                  // obligatorio, entero de 1 a 10000
    "logoUrl": "https://cdn.central.co/logo.png", // opcional (o null); http:// o https://
    "clave": "clave-segura-123"            // obligatorio, 8 a 64 caracteres
  }
  ```

- Responde **201**:

  ```json
  {
    "mensaje": "Empresa registrada. Tu prueba gratuita de 15 días comenzó hoy.",
    "token": "<jwt>",
    "usuario": { "id": "…", "correo": "admin@central.co", "rol": "admin", "empresaId": "…" },
    "empresa": {
      "id": "…", "nombre": "Barbería Central", "codigoAcceso": "K7M2QX",
      "estadoSuscripcion": "trial", "trialEndsAt": "2026-11-02T18:00:00.000Z", "diasPruebaRestantes": 15
    }
  }
  ```

  `codigoAcceso` (6 letras y números) es el código que los clientes usan en `/empresas/validar/:codigo`. `trialEndsAt` = momento del registro + 15 días.
- Errores: **400** dato faltante o inválido (ej. `El campo "ciudad" es obligatorio`, `La hora de cierre debe ser posterior a la hora de apertura`, `El número de empleados debe ser un número entero mayor que cero`, `El correo no es válido`); **409** `Ya existe una cuenta con ese correo` o `Ya existe una empresa registrada con ese NIT`; **429** demasiados registros.

**POST `/api/v1/cuentas/registro/cliente`**: crea una cuenta de cliente (sin empresa).

- Recibe `{ "correo": "cliente@correo.com", "clave": "8 a 64 caracteres" }`.
- Responde **201** `{ "mensaje": "Cuenta creada", "token": "<jwt>", "usuario": { "id", "correo", "rol": "cliente", "empresaId": null } }`.
- Errores: **400** (`Envía correo y contraseña` si no hay cuerpo, `El campo "correo" es obligatorio`, `El correo no es válido`, `La contraseña debe tener entre 8 y 64 caracteres`); **409** `Ya existe una cuenta con ese correo`; **429**.

**POST `/api/v1/cuentas/login`**: login de administradores de empresa y clientes.

- Recibe `{ "correo", "clave" }` (el correo no distingue mayúsculas).
- Responde **200** `{ "mensaje": "Autenticación exitosa", "token": "<jwt>", "usuario": { "id", "correo", "rol", "empresaId" } }`. `usuario.rol` (`admin` o `cliente`) indica qué pantallas mostrar.
- Errores: **400** `Debes enviar correo y contraseña`; **401** `Correo o contraseña incorrectos` (igual si el correo no existe); **429**.

**GET `/api/v1/admin/empresa/prueba`**: días de prueba que le quedan a la empresa del administrador.

- Responde **200** `{ "estadoSuscripcion": "trial", "trialEndsAt": "<fecha ISO>", "diasRestantes": 12, "pruebaVencida": false }`.
- `diasRestantes` se redondea hacia arriba (quedan 2 horas = 1) y nunca es negativo; es `null` si la empresa no está en prueba (por ejemplo `"activa"`). Con la prueba vencida responde `diasRestantes: 0` y `pruebaVencida: true`.

**GET `/api/v1/admin/empresa`**: perfil de la empresa del administrador (siempre la suya; no recibe id).

- Responde **200** `{ "id", "nombre", "codigoAcceso", "categoria", "nit", "telefono", "correo", "direccion", "ciudad", "diasAtencion", "horarioApertura": "08:00", "horarioCierre": "19:00", "nombreAdministradora", "numeroEmpleados", "logoUrl", "fotoUrl", "colorPrimario", "colorSecundario", "estadoSuscripcion", "trialEndsAt", "creadaEn" }`.
- `fotoUrl` es la dirección completa de la foto subida (ej. `https://api.mibarberia.co/uploads/empresas/<uuid>.jpg`) o `null` si no tiene. `logoUrl` es otro campo: una dirección web que el administrador escribe a mano.

**PATCH `/api/v1/admin/empresa`**: modifica la empresa del administrador.

- Recibe uno o más campos del registro (sin `clave`): `nombre`, `categoria`, `nit` (`null` lo quita), `telefono`, `correo`, `direccion`, `ciudad`, `diasAtencion`, `horarioApertura`, `horarioCierre`, `nombreAdministradora`, `numeroEmpleados`, `logoUrl`. Mismas validaciones del registro. Se ignoran `id`, `empresaId`, `estadoSuscripcion`, `trialEndsAt` y cualquier otro campo.
- Cambiar `correo` aquí cambia el correo de contacto de la empresa, **no** el correo de inicio de sesión del administrador.
- Responde **200** con el perfil actualizado (misma forma que el GET).
- Errores: **400** `Envía al menos un dato para actualizar` y los de validación; **409** NIT repetido.

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

- Responde **200** `{ "id", "nombre", "codigoAcceso", "categoria", "telefono", "correo", "direccion", "ciudad", "diasAtencion", "horarioApertura": "08:00", "horarioCierre": "19:00", "logoUrl", "fotoUrl", "colorPrimario", "colorSecundario" }`. No incluye NIT, nombre de la administradora, número de empleados ni datos de la suscripción. Los campos sin dato llegan como `null`.
- Errores: **404** `Establecimiento no encontrado`; **429** demasiados intentos.

**Errores comunes de `/api/v1/admin/...`**

- **401**: sin token, token vencido o token del personal.
- **403** `Solo el administrador de una empresa puede usar esta función.` (por ejemplo, un cliente).
- **402**: suscripción no vigente (no aplica a `/prueba`; también lo responde `PATCH /citas/:id/cancelar`). Mensajes:
  - prueba vencida: `Tu prueba gratuita de 15 días terminó. Activa tu suscripción para seguir usando las funciones de administrador.`
  - `vencida`: `La suscripción de tu empresa venció. Renuévala para seguir usando las funciones de administrador.`
  - `cancelada`: `La suscripción de tu empresa está cancelada. Actívala para seguir usando las funciones de administrador.`

### Gestión del negocio (personal y cuenta del administrador)

Todos usan `Authorization: Bearer <token>` del barbero o de la cuenta admin. El negocio sale siempre de la sesión: nunca va en la URL ni en el cuerpo, y un `:id` de otro negocio responde 404.

**Errores comunes de estos endpoints**

- **401** `Sesión no válida. Inicia sesión de nuevo.` o `Sesión vencida. Inicia sesión de nuevo.`
- **403** `Esta función es solo para el personal del negocio.` (token de cliente) o `Solo el administrador del negocio puede usar esta función.` (barbero sin `esAdmin` en un endpoint de admin).
- **402**: prueba gratuita vencida o suscripción no vigente, con los mismos mensajes de `/api/v1/admin/...`. Aplica a todos estos endpoints (también a los barberos), menos a los públicos.
- **400** `Envía al menos un dato para actualizar` en un `PATCH` sin campos, y el mensaje de validación del campo (ej. `El campo "nombre" es obligatorio`).

**Fotos de equipo y productos**: `PUT .../foto` recibe `multipart/form-data` con un solo archivo en el campo `foto`, igual que la foto del negocio: JPG, PNG o WEBP (se comprueba por el contenido), máximo 5 MB. Errores **400** `La foto debe ser una imagen JPG, PNG o WEBP` o `Envía la imagen en el campo "foto" (multipart/form-data)`; **413** `La foto no puede pesar más de 5 MB`. La foto anterior se borra del servidor. Los archivos quedan en `<CARPETA_SUBIDAS>/barberos/` o `<CARPETA_SUBIDAS>/productos/`; la API devuelve la dirección completa (`https://…/uploads/barberos/<uuid>.jpg`). Las fotos antiguas del equipo que ya eran direcciones web se devuelven tal cual. `/empresas/actual` y `/empresas/validar/:codigo` también devuelven `foto` del equipo como dirección completa.

#### Clientes (solo admin)

**GET `/api/v1/clientes`**: **200** clientes del negocio, del más reciente al más antiguo:

```json
[{ "id": "…", "nombre": "Juan", "telefono": "3001234567", "indicativo": "57", "totalCitas": 4,
   "fechaUltimaCita": "2026-10-10", "enListaNegra": false, "listaNegraId": null }]
```

**GET `/api/v1/clientes/:id/historial`**: **200** `{ "cliente": { …misma forma que la lista… }, "citas": [{ "id", "fecha": "2026-10-10", "hora": "03:30 PM", "servicio", "barberoId", "barberoNombre", "precio": 25000, "estado": "COMPLETADA" }] }`, citas de la más reciente a la más antigua. **404** `Cliente no encontrado`.

**GET `/api/v1/clientes/lista-negra`**: **200** `[{ "id", "nombre", "telefono", "agregadoEn": "<fecha ISO>" }]`.

**POST `/api/v1/clientes/lista-negra`**: recibe `{ "clienteId": "…" }` y guarda el nombre y teléfono de ese cliente. **201** `{ "mensaje": "Cliente agregado a la lista negra", "id", "nombre", "telefono", "agregadoEn" }`. Errores: **400** `Envía el identificador del cliente en "clienteId"`; **404** `Cliente no encontrado`; **409** `Este cliente ya está en la lista negra`.

**DELETE `/api/v1/clientes/lista-negra/:id`** (`:id` = `id` de la lista negra, o `listaNegraId` del cliente): **200** `{ "mensaje": "Cliente quitado de la lista negra" }`. **404** `Ese registro no está en la lista negra`.

Un teléfono de la lista negra (se comparan solo los dígitos) no puede reservar: `POST /api/v1/citas` responde **403** `No es posible agendar con este número. Comunícate con el negocio.`

#### Equipo (solo admin)

Forma de un profesional: `{ "id", "nombre", "usuario", "esAdmin": false, "especialidad": "Barbero" | null, "porcentajeGanancia": 50, "foto": "<url>" | null }`.

**GET `/api/v1/equipo`**: **200** lista del equipo activo.

**POST `/api/v1/equipo`**: recibe

```jsonc
{
  "nombre": "Carlos",            // obligatorio, máx. 100
  "usuario": "carlos.r",         // obligatorio, 3 a 60: letras, números, . _ -; único (sin distinguir mayúsculas)
  "clave": "clave-segura",       // obligatorio, 8 a 64 caracteres; con ella entra en /api/v1/auth/login
  "esAdmin": false,              // opcional, por defecto false
  "especialidad": "Barbero",     // opcional (o null), máx. 100
  "porcentajeGanancia": 50       // opcional, 0 a 100, por defecto 50
}
```

**201** con el profesional. Errores: **400** validación (ej. `La contraseña debe tener entre 8 y 64 caracteres`); **409** `Ese usuario ya está en uso. Elige otro.`

**PATCH `/api/v1/equipo/:id`**: uno o más campos del POST (`clave` cambia la contraseña; `especialidad: null` la quita). **200** con el profesional. Errores: **400** `No puedes quitarte a ti mismo el rol de administrador.`; **404** `Profesional no encontrado`; **409** usuario repetido.

**DELETE `/api/v1/equipo/:id`**: **200** `{ "mensaje": "Profesional eliminado" }`. Ya no inicia sesión ni recibe reservas; sus citas pasadas y la cartera lo siguen mostrando. Errores: **400** `No puedes eliminar tu propio usuario.`; **404** `Profesional no encontrado`; **409** `Este profesional tiene N cita(s) pendiente(s). Cancélalas antes de eliminarlo.`

**PUT `/api/v1/equipo/:id/foto`** (multipart, campo `foto`): **200** `{ "mensaje": "Foto del profesional actualizada", "foto": "<url>" }`. **404** `Profesional no encontrado`.

#### Servicios

Forma: `{ "id", "nombre", "duracionMin": 30, "duracion": "30 min", "precio": 25000 }`.

**GET `/api/v1/servicios`** (cualquier personal): **200** servicios activos.

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

#### Bloqueos semanales de horario

Un bloqueo se repite cada semana el mismo día (ej. almuerzo de los lunes). Forma: `{ "id", "barberoId", "barberoNombre", "diaSemana": 1, "horaInicio": "12:00", "horaFin": "13:00", "motivo": "Almuerzo" | null }`; `diaSemana`: 0 = domingo … 6 = sábado.

**GET `/api/v1/bloqueos`** (personal): **200** lista. Un admin ve todo el equipo (opcional `?barberoId=` para filtrar); un barbero, solo los suyos.

**POST `/api/v1/bloqueos`** (personal): recibe `{ "barberoId": "…", "diaSemana": 1, "horaInicio": "12:00", "horaFin": "13:00", "motivo": "Almuerzo" }`. Horas HH:MM de 24 h, fin posterior al inicio; `motivo` opcional (máx. 200). Un admin debe enviar `barberoId`; un barbero puede omitirlo (se usa el suyo). **201** con el bloqueo. Errores: **400** `Elige el profesional en "barberoId"` o `La hora de fin debe ser posterior a la hora de inicio`; **403** `Solo puedes bloquear tu propio horario.`; **404** `Profesional no encontrado`.

**DELETE `/api/v1/bloqueos/:id`** (personal; un barbero solo los suyos): **200** `{ "mensaje": "Bloqueo eliminado" }`. **404** `Bloqueo no encontrado`.

**GET `/api/v1/citas/bloqueos?empresaId=`** (público, para la pantalla de reservar): **200** `[{ "barberoId", "diaSemana": 1, "fecha": null, "horaInicio": "12:00", "horaFin": "13:00" }]`, sin motivo. `fecha` solo viene en bloqueos antiguos de un día puntual (entonces `diaSemana` es `null`). Una reserva que cae en un bloqueo responde **409** `El profesional no atiende en ese horario. Por favor elige otra hora.`

#### Cartera

**GET `/api/v1/cartera?desde=2026-10-01&hasta=2026-10-31`** (personal; admin: todo el negocio; barbero: solo lo suyo). Suma las citas **completadas** con fecha entre `desde` y `hasta` (incluidas). La ganancia de cada cita usa el porcentaje que tenía el profesional **cuando se completó** (se guarda en `citas.porcentaje_ganancia`, migración 006); cambiar después su porcentaje no cambia lo que ya ganó. El negocio se queda con el resto. En `porProfesional`, `porcentajeGanancia` es el porcentaje **actual** del profesional (informativo); `ganancia` puede no coincidir con `ventas × porcentajeGanancia` si el porcentaje cambió dentro del rango. Las citas completadas antes de la migración 006 tomaron el porcentaje que el profesional tenía ese día.

```json
{
  "desde": "2026-10-01", "hasta": "2026-10-31",
  "totalCitas": 42, "totalVentas": 1050000, "gananciaEquipo": 525000, "gananciaNegocio": 525000,
  "porProfesional": [
    { "barberoId": "…", "nombre": "Carlos", "activo": true, "porcentajeGanancia": 50,
      "citas": 20, "ventas": 500000, "ganancia": 250000 }
  ]
}
```

Errores: **400** `El campo "desde" es obligatorio`, `El campo "desde" debe ser una fecha real con el formato AAAA-MM-DD`, `La fecha "hasta" no puede ser anterior a "desde"` o `El rango no puede ser mayor que 366 días`.

## Autenticación y roles

- Personal: login con `usuario` + `clave` contra `barberos` activos (bcrypt, costo 12). El token lleva `sub` (id del barbero) y `empresaId`. `requerirSesion` **lee `es_admin` de la base en cada solicitud**, así que un cambio de rol aplica de inmediato; `requerirAdmin` exige admin. Un barbero eliminado (`activo = false`) pierde la sesión.
- `requerirSesion` también acepta el token de una cuenta `admin`: la sesión queda con `usuarioId`, `barberoId: null`, la empresa de la cuenta y `esAdmin: true` (`src/modules/auth/auth.servicio.ts`). Si la cuenta completó o canceló una cita, queda en `citas.completada_por_usuario` / `cancelada_por_usuario` (migración 005). `crearPermisos` (`src/modules/auth/permisos.ts`) arma las guardias `personal` y `admin` de los módulos de gestión; ambas exigen suscripción vigente.
- Cuentas: login con `correo` + `clave` contra `usuarios` (bcrypt, costo 12). El token lleva `sub` (id del usuario) y `tipo: "cuenta"`. `requerirCuenta` **lee `rol` y `empresa_id` de la base en cada solicitud**; `requerirAdminEmpresa` exige `rol = admin` con empresa (`src/modules/cuentas/cuentas.guardias.ts`).
- Los tokens son JWT HS256 y duran `JWT_EXPIRA_EN`.
- Prueba gratuita (15 días desde el registro): `requerirSuscripcionVigente` (`src/modules/empresas/suscripcion.ts`) va después de la guardia de admin en todo endpoint de administrador. Deja pasar `activa` y `trial` con `trial_ends_at` futuro; lo demás responde 402. Las empresas creadas antes de la 003 quedaron `activa`.

## Reglas de seguridad (auditoría previa)

- Negocio, usuario y rol salen **de la sesión**, nunca del cuerpo ni de la URL.
- Toda entrada se valida con zod en la capa de rutas (`parsear`); el cuerpo JSON tiene un límite de 10 kb.
- SQL siempre parametrizado (`$1`, `$2`…). Nunca concatenes valores del usuario.
- Las consultas usan listas explícitas de columnas: nada de `SELECT *`, para no filtrar `password_hash`, datos de clientes ni columnas nuevas.
- Errores siempre como `{ "error": "mensaje" }`, sin pila ni SQL; el detalle queda solo en el log del servidor (`shared/http/manejadorErrores.ts`).
- Integridad en la base: llaves foráneas compuestas `(empresa_id, …)` aíslan negocios; `citas_sin_solapamiento` impide dobles reservas (la API responde 409); CHECK en estados, horarios y precios.
- Límites por IP (login, código de negocio, reservas, registro, general), `helmet` y CORS con lista de orígenes.
- Prueba cada regla nueva con un test de integración en `test/`.
