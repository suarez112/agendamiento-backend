# Admin account access to staff endpoints and business management endpoints

Objective: let the company admin account (`usuarios`, role `admin`) use every staff endpoint of its own company, and add management endpoints (clients, team, services, products, weekly blocks, earnings). Backend only.
Branch: `feature/registro-empresa`. Delivery: single branch, work-unit commits, push authorized by the user. Test runner: none this round — the user asked not to write or run automated tests; verification is "the server starts without errors" plus `npm run typecheck`.

## Specs

- S1 — "la cuenta de administradora (la que se registra con correo) no puede usar la agenda ni los endpoints del personal. Haz que la administradora pueda usar todo lo de SU empresa (agenda, citas, equipo, servicios, etc.). Los usuarios del personal deben seguir funcionando como ahora." Approved approach: one staff session that accepts both tokens; migration 005 records which account completed/cancelled an appointment.
- S2 — "Clientes: ver historial, y agregar/quitar de la lista negra."
- S3 — "Equipo: crear, editar, borrar y cambiar la foto de un barbero (JPG/PNG/WEBP, máximo 5 MB)."
- S4 — "Servicios: crear, editar y borrar."
- S5 — "Productos: crear, editar y borrar, con foto opcional; y que los clientes puedan ver el catálogo."
- S6 — "Bloqueo semanal: crear, ver y borrar bloqueos de horario."
- S7 — "Cartera: un endpoint que dé el resumen de ganancias por rango de fechas."
- S8 — S2–S7 "solo para la empresa de quien inicia sesión y respetando el bloqueo cuando vence la prueba gratuita". "No hagas notificaciones por ahora."
- S9 — "Si creaste migraciones, ejecútalas con npm run db:migrate y confirma que funcionaron."
- S10 — "Actualiza AGENTS.md con todos los endpoints nuevos (método, ruta, qué recibe y qué responde)."
- S11 — "Haz commit y push." Constraints: "No escribas ni ejecutes pruebas automáticas ni pidas revisiones; solo verifica que el servidor arranque sin errores." "crea una migración nueva (no edites las anteriores)."

Assumptions (recorded so they can be changed later):
- A1 — Team members and services are soft-deleted (`activo = false`) so past appointments and earnings keep their data; a team member with future confirmed appointments cannot be deleted (409).
- A2 — A blacklisted phone cannot book (`POST /citas` answers 403); clients are blacklisted from their client record.
- A3 — Weekly blocks also reject bookings that overlap them (409) and are published without the reason at `GET /citas/bloqueos?empresaId=`.
- A4 — (Rewritten after L5.) Earnings use only `COMPLETADA` appointments and the percentage stored on each appointment when it was completed (`citas.porcentaje_ganancia`, migration 006); appointments completed before 006 take the member's percentage at migration time.
- A5 — Product and team photos are set with their own `PUT .../foto` endpoint (optional photo).

## Tasks

- [x] T1 — S1: shared staff session for admin accounts, migration 005, appointments (blacklist and block checks on booking). Route: inline. Commit: first feat commit.
- [x] T2 — S2–S8: modules clientes, equipo, servicios, productos, bloqueos, cartera; photo store per type. Route: inline (modules share the session, guards and photo store; no parallel Writer reason). Commit: second feat commit.
- [x] T3 — S9–S11: migrate, start server, AGENTS.md, commit, push. Route: inline. Commit: docs commit.
- [x] T4 — A4 (L5): store the percentage when completing, migration 006, earnings from the stored value, AGENTS.md. Route: inline. Commit: fix(cartera) commit.

## Log

- L1 (2026-10-18, user request) — see S1–S11 (quoted verbatim from the request).
- L2 (2026-10-18) — User confirmed the shared-session approach: "Sí, confirmo el enfoque. Continúa con el punto 1 y luego con los puntos 2, 3 y 4."
- L3 (2026-10-18) — Evidence: `npm run typecheck` clean (src and test). `npm run db:migrate` applied `004_foto_empresa.sql` (was pending) and `005_gestion_negocio.sql`; schema_migrations = 001–005; columns `citas.completada_por_usuario`, `citas.cancelada_por_usuario`, `barberos.activo`, `servicios.activo`, `productos.descripcion` exist; barberos unique index is now `barberos_usuario_activo_key`. Server started on a spare port: `GET /api/saludo` 200, `/api/v1/equipo` and `/api/v1/cartera` without token 401, `/api/v1/productos/catalogo/NOEXISTE` 404, `/api/v1/citas/bloqueos?empresaId=x` 200 `[]`; log without errors (only the pre-existing `jwt_secret_corto` warning).
- L4 (2026-10-18) — Not run by request: automated tests and reviews. Known contract change: `test/cuentas.test.ts` "el token de una cuenta no sirve en los endpoints del personal, ni al revés" expects 401 for the admin account token on `/citas/agenda` and `/empresas/actual`; it now gets 200 (admin) and 403 (client) by design (S1). Pending: update that test and add integration tests for S1–S7 when tests are allowed.
- L5 (2026-10-18, user correction, verbatim) — "Cambia la decisión 4: la cartera debe usar el porcentaje de ganancia que tenía el barbero cuando se completó la cita, no el de hoy. Guarda ese porcentaje al completar la cita (con una migración nueva). Para las citas ya completadas, usa el porcentaje actual como valor inicial. Ejecuta la migración, haz commit y push. Las otras 3 decisiones están bien."
- L6 (2026-10-18) — Evidence: `npm run typecheck` clean; `npm run db:migrate` applied `006_porcentaje_en_cita.sql`; schema_migrations = 001–006; 1 completed appointment, 0 without percentage; constraints `citas_porcentaje_valido` and `citas_completada_con_porcentaje` present. Server started: `/api/saludo` 200, `/api/v1/cartera` without token 401, no errors in the log. Tests and reviews not run (user request).
