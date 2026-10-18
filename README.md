# agendamiento-backend

API REST (Express 5 + PostgreSQL) para agendar citas en barberías. Varios negocios comparten la misma base; cada uno solo ve sus datos.

## Puesta en marcha

```bash
npm install
# crea .env con las variables de la tabla siguiente
npm run db:migrate          # crea o actualiza el esquema
npm run dev                 # http://localhost:4000/api/saludo
```

### Variables de entorno

Se validan al arrancar (`src/config/entorno.ts`); si falta una, el servidor no inicia y dice cuál. Nunca subas `.env` al repositorio.

| Variable | Por defecto | Notas |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` o `production` |
| `PORT` | `4000` | |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | — | obligatorias |
| `DB_PORT` | `5432` | |
| `DB_POOL_MAX` | `10` | conexiones máximas del pool |
| `JWT_SECRET` | — | obligatoria; mínimo 32 caracteres en producción. Genera una con `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `JWT_EXPIRA_EN` | `12h` | formato `30m`, `12h`, `7d` |
| `CORS_ORIGINS` | vacío | orígenes web permitidos, separados por comas. La app nativa no los necesita; fuera de producción se permite `http://localhost:<puerto>` |
| `TRUST_PROXY` | `0` | número de proxies delante del servidor (afecta la IP de los límites) |

| Script | Qué hace |
| --- | --- |
| `npm run dev` | Servidor con recarga automática |
| `npm run build` / `npm start` | Compila a `dist/` y lo ejecuta |
| `npm run typecheck` | Revisa tipos de `src/` y `test/` |
| `npm test` | Pruebas de integración: crean y borran una base temporal en el PostgreSQL de `.env` (el usuario necesita permiso `CREATEDB`) |
| `npm run db:migrate` | Aplica las migraciones pendientes de `db/migraciones` |
| `npm run db:cifrar-contrasenas` | Cifra con bcrypt las contraseñas que aún estén en texto plano. **Haz un respaldo antes:** no se puede deshacer |

## Estructura

```
src/
  server.ts            arranque, apagado ordenado
  app.ts               composición: crea servicios y conecta rutas (recibe pool y entorno)
  config/entorno.ts    variables de entorno validadas con zod
  db/                  pool, transacciones, migraciones y scripts
  shared/              errores, registro (logs JSON) y middlewares HTTP (CORS, límites, validación, errores)
  modules/
    auth/              login, contraseñas (bcrypt), tokens JWT, guardias de sesión y de admin
    cuentas/           registro de empresas y clientes, login y guardias de cuentas (tabla usuarios)
    empresas/          datos públicos del negocio, vista del personal, perfil del admin y prueba gratuita
    citas/             reservas, agenda, completar y cancelar
db/migraciones/        SQL numerado; cada archivo corre en su propia transacción
test/                  pruebas (node:test) con una base temporal por archivo
```

Cada módulo separa **rutas** (HTTP y validación), **servicio** (reglas de negocio) y **repositorio** (SQL). Para un módulo nuevo, copia esa forma y conéctalo en `app.ts`.

## Reglas de seguridad

- **Negocio y rol salen de la sesión**, nunca del cuerpo de la solicitud. El token solo guarda `sub` (barbero) y `empresaId`; `es_admin` se lee de la base en cada solicitud, así que quitar un rol o eliminar a alguien aplica de inmediato.
- **Contraseñas con bcrypt** (costo 12). Las heredadas en texto plano se aceptan una vez y se cifran al iniciar sesión.
- **Doble reserva imposible**: la restricción `citas_sin_solapamiento` (PostgreSQL, `btree_gist`) rechaza la segunda de dos reservas simultáneas que se solapen; la API responde 409.
- **Aislamiento en la base**: llaves foráneas compuestas `(empresa_id, …)` impiden que una cita apunte a un profesional, servicio o cliente de otro negocio.
- **Límites por IP** (en memoria): login 10 intentos fallidos / 15 min, código de negocio 60, reservas 20, registro 10, general 300. Con varias instancias usa un store compartido (Redis).
- **Errores**: siempre `{ "error": "mensaje" }`, sin pila ni SQL. Los detalles quedan en el log del servidor.
- Toda consulta usa parámetros (`$1`, `$2`…); nunca concatenes valores del usuario en SQL.

## Endpoints

| Método | Ruta | Acceso |
| --- | --- | --- |
| GET | `/api/saludo` | público (salud) |
| POST | `/api/v1/auth/login` | público, limitado |
| GET | `/api/v1/empresas/validar/:codigo` | público, limitado (sin usuarios de login) |
| GET | `/api/v1/empresas/actual` | sesión (incluye usuarios del equipo) |
| POST | `/api/v1/citas` | público, limitado |
| GET | `/api/v1/citas/ocupadas?empresaId=` | público (sin datos de clientes) |
| GET | `/api/v1/citas/agenda` | sesión (admin: todo el negocio; barbero: sus citas) |
| PATCH | `/api/v1/citas/:id/completar` | sesión, solo el profesional de la cita |
| PATCH | `/api/v1/citas/:id/cancelar` | sesión, solo admin del negocio, suscripción vigente |
| POST | `/api/v1/cuentas/registro/empresa` | público, limitado (crea empresa + administrador, prueba de 15 días) |
| POST | `/api/v1/cuentas/registro/cliente` | público, limitado |
| POST | `/api/v1/cuentas/login` | público, limitado (administradores de empresa y clientes) |
| GET | `/api/v1/admin/empresa/prueba` | cuenta admin (días de prueba restantes) |
| GET | `/api/v1/admin/empresa` | cuenta admin, suscripción vigente |
| PATCH | `/api/v1/admin/empresa` | cuenta admin, suscripción vigente |

La cuenta del administrador de la empresa también usa los endpoints del personal. Gestión del negocio (`/api/v1/clientes`, `/equipo`, `/servicios`, `/productos`, `/bloqueos`, `/cartera`) y fotos: ver `AGENTS.md`.

Datos que recibe y responde cada endpoint de cuentas y administración: ver `AGENTS.md`.
