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
  modules/<modulo>/  auth, cuentas, empresas, citas: <m>.rutas.ts (HTTP + zod) → <m>.servicio.ts (reglas) → <m>.repositorio.ts (SQL)
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
- Variables en `.env` en la raíz (ignorado por git; nunca lo subas). Se validan al arrancar en `src/config/entorno.ts`: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_MAX`, `JWT_SECRET`, `JWT_EXPIRA_EN`, `CORS_ORIGINS`, `TRUST_PROXY`, `NODE_ENV`, `PORT`.
- El esquema solo cambia con un archivo nuevo en `db/migraciones/` (siguiente número). Nunca edites una migración ya aplicada.

## Endpoints

Todas las respuestas son JSON. Los errores siempre llegan como `{ "error": "mensaje" }`, listo para mostrar al usuario.

| Método | Ruta | Acceso |
| --- | --- | --- |
| GET | `/api/saludo` | público (salud) |
| POST | `/api/v1/auth/login` | público, limitado. Personal (barberos). Cuerpo `{ usuario, clave }` |
| GET | `/api/v1/empresas/validar/:codigo` | público, limitado |
| GET | `/api/v1/empresas/actual` | sesión del personal |
| POST | `/api/v1/citas` | público, limitado |
| GET | `/api/v1/citas/ocupadas?empresaId=` | público (sin datos de clientes) |
| GET | `/api/v1/citas/agenda` | sesión del personal (admin: todo el negocio; barbero: sus citas) |
| PATCH | `/api/v1/citas/:id/completar` | sesión del personal, solo el profesional de la cita |
| PATCH | `/api/v1/citas/:id/cancelar` | sesión del personal, solo admin del negocio, suscripción vigente (402 si no) |
| POST | `/api/v1/cuentas/registro/empresa` | público, limitado. Crea empresa + administrador |
| POST | `/api/v1/cuentas/registro/cliente` | público, limitado |
| POST | `/api/v1/cuentas/login` | público, limitado. Administradores de empresa y clientes |
| GET | `/api/v1/admin/empresa/prueba` | cuenta admin (responde aunque la prueba haya vencido) |
| GET | `/api/v1/admin/empresa` | cuenta admin, suscripción vigente |
| PATCH | `/api/v1/admin/empresa` | cuenta admin, suscripción vigente |

### Contrato de cuentas, prueba gratuita y administración

Hay dos tipos de sesión y sus tokens **no se mezclan** (usar uno en los endpoints del otro responde 401):

- **Personal** (`/api/v1/auth/login`, tabla `barberos`): sirve en `/empresas/actual` y `/citas/...`.
- **Cuenta** (`/api/v1/cuentas/...`, tabla `usuarios`, `rol` = `admin` | `cliente`): sirve en `/api/v1/admin/...`.

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
- Errores: **400** (`El correo no es válido`, `La contraseña debe tener entre 8 y 64 caracteres`); **409** `Ya existe una cuenta con ese correo`; **429**.

**POST `/api/v1/cuentas/login`**: login de administradores de empresa y clientes.

- Recibe `{ "correo", "clave" }` (el correo no distingue mayúsculas).
- Responde **200** `{ "mensaje": "Autenticación exitosa", "token": "<jwt>", "usuario": { "id", "correo", "rol", "empresaId" } }`. `usuario.rol` (`admin` o `cliente`) indica qué pantallas mostrar.
- Errores: **400** `Debes enviar correo y contraseña`; **401** `Correo o contraseña incorrectos` (igual si el correo no existe); **429**.

**GET `/api/v1/admin/empresa/prueba`**: días de prueba que le quedan a la empresa del administrador.

- Responde **200** `{ "estadoSuscripcion": "trial", "trialEndsAt": "<fecha ISO>", "diasRestantes": 12, "pruebaVencida": false }`.
- `diasRestantes` se redondea hacia arriba (quedan 2 horas = 1) y nunca es negativo; es `null` si la empresa no está en prueba (por ejemplo `"activa"`). Con la prueba vencida responde `diasRestantes: 0` y `pruebaVencida: true`.

**GET `/api/v1/admin/empresa`**: perfil de la empresa del administrador (siempre la suya; no recibe id).

- Responde **200** `{ "id", "nombre", "codigoAcceso", "categoria", "nit", "telefono", "correo", "direccion", "ciudad", "diasAtencion", "horarioApertura": "08:00", "horarioCierre": "19:00", "nombreAdministradora", "numeroEmpleados", "logoUrl", "colorPrimario", "colorSecundario", "estadoSuscripcion", "trialEndsAt", "creadaEn" }`.

**PATCH `/api/v1/admin/empresa`**: modifica la empresa del administrador.

- Recibe uno o más campos del registro (sin `clave`): `nombre`, `categoria`, `nit` (`null` lo quita), `telefono`, `correo`, `direccion`, `ciudad`, `diasAtencion`, `horarioApertura`, `horarioCierre`, `nombreAdministradora`, `numeroEmpleados`, `logoUrl`. Mismas validaciones del registro. Se ignoran `id`, `empresaId`, `estadoSuscripcion`, `trialEndsAt` y cualquier otro campo.
- Cambiar `correo` aquí cambia el correo de contacto de la empresa, **no** el correo de inicio de sesión del administrador.
- Responde **200** con el perfil actualizado (misma forma que el GET).
- Errores: **400** `Envía al menos un dato para actualizar` y los de validación; **409** NIT repetido.

**Errores comunes de `/api/v1/admin/...`**

- **401**: sin token, token vencido o token del personal.
- **403** `Solo el administrador de una empresa puede usar esta función.` (por ejemplo, un cliente).
- **402**: suscripción no vigente (no aplica a `/prueba`; también lo responde `PATCH /citas/:id/cancelar`). Mensajes:
  - prueba vencida: `Tu prueba gratuita de 15 días terminó. Activa tu suscripción para seguir usando las funciones de administrador.`
  - `vencida`: `La suscripción de tu empresa venció. Renuévala para seguir usando las funciones de administrador.`
  - `cancelada`: `La suscripción de tu empresa está cancelada. Actívala para seguir usando las funciones de administrador.`

## Autenticación y roles

- Personal: login con `usuario` + `clave` contra `barberos` (bcrypt, costo 12). El token lleva `sub` (id del barbero) y `empresaId`. `requerirSesion` **lee `es_admin` de la base en cada solicitud**, así que un cambio de rol aplica de inmediato; `requerirAdmin` exige admin.
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
