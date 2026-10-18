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
  modules/<modulo>/  auth, empresas, citas: <m>.rutas.ts (HTTP + zod) → <m>.servicio.ts (reglas) → <m>.repositorio.ts (SQL)
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

| Método | Ruta | Acceso |
| --- | --- | --- |
| GET | `/api/saludo` | público (salud) |
| POST | `/api/v1/auth/login` | público, limitado. Cuerpo `{ usuario, clave }` |
| GET | `/api/v1/empresas/validar/:codigo` | público, limitado |
| GET | `/api/v1/empresas/actual` | sesión |
| POST | `/api/v1/citas` | público, limitado |
| GET | `/api/v1/citas/ocupadas?empresaId=` | público (sin datos de clientes) |
| GET | `/api/v1/citas/agenda` | sesión (admin: todo el negocio; barbero: sus citas) |
| PATCH | `/api/v1/citas/:id/completar` | sesión, solo el profesional de la cita |
| PATCH | `/api/v1/citas/:id/cancelar` | sesión, solo admin del negocio |

## Autenticación y roles

- Login con `usuario` + `clave` contra la tabla `barberos` (contraseñas con bcrypt, costo 12). Devuelve un JWT HS256 que dura `JWT_EXPIRA_EN`.
- El token solo lleva `sub` (id del barbero) y `empresaId`. Se envía como `Authorization: Bearer <token>`.
- `requerirSesion` valida el token y **lee `es_admin` de la base en cada solicitud**, así que un cambio de rol aplica de inmediato. `requerirAdmin` exige admin.
- La migración 003 agrega la tabla `usuarios` (`rol` = `admin` | `cliente`; un admin tiene `empresa_id` y un cliente no). **La API todavía no la usa**: el login sigue siendo el de `barberos`.

## Reglas de seguridad (auditoría previa)

- Negocio, usuario y rol salen **de la sesión**, nunca del cuerpo ni de la URL.
- Toda entrada se valida con zod en la capa de rutas (`parsear`); el cuerpo JSON tiene un límite de 10 kb.
- SQL siempre parametrizado (`$1`, `$2`…). Nunca concatenes valores del usuario.
- Las consultas usan listas explícitas de columnas: nada de `SELECT *`, para no filtrar `password_hash`, datos de clientes ni columnas nuevas.
- Errores siempre como `{ "error": "mensaje" }`, sin pila ni SQL; el detalle queda solo en el log del servidor (`shared/http/manejadorErrores.ts`).
- Integridad en la base: llaves foráneas compuestas `(empresa_id, …)` aíslan negocios; `citas_sin_solapamiento` impide dobles reservas (la API responde 409); CHECK en estados, horarios y precios.
- Límites por IP (login, código de negocio, reservas, general), `helmet` y CORS con lista de orígenes.
- Prueba cada regla nueva con un test de integración en `test/`.
