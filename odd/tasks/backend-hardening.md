# Backend hardening and modular architecture

Objective: restructure `agendamiento-backend` into feature modules and close the security/integrity gaps listed by the user, keeping the API contract the app (`C:\Users\eduar_9\app`) consumes.
Branch: `feat/backend-hardening` (baseline `2dec223`, repo initialized this session). Delivery: exception-ok (local repo, no remote; work-unit commits only). Test runner: `tsx --test` (node:test) with a disposable PostgreSQL database per run.

## Specs

- S1 — "Usando buenas practicas haz que la aplicación sea mas mantenible y modular para que sea escalable al largo plazo". Scope: feature modules (routes → controller → service → repository), validated env config, central error handling, app factory with injected dependencies, versioned SQL migrations, automated tests, graceful shutdown.
- S2 — "Utiliza un emulador para verificar los cambios en un dispositivo real, corre los procesos necesarios para lanzar este emulador si no está disponible a la primers." Verify on the `Pixel_7_Pro` AVD.
- S3 — "Utiliza y corre el frontend ubicado en app". The Expo app must work against the hardened backend.
- S4 — "Inyección SQL y validación de entradas."
- S5 — "Autenticación, contraseñas y sesiones o tokens."
- S6 — "Permisos de administradores, empleados y clientes."
- S7 — "Aislamiento de datos entre diferentes negocios."
- S8 — "Acceso no autorizado a citas, clientes, servicios y empleados."
- S9 — "Doble reserva de un mismo horario por solicitudes simultáneas."
- S10 — "CORS, limitación de solicitudes y manejo de errores, según corresponda."
- S11 — "Dependencias vulnerables y exposición de secretos."
- S12 — "Transacciones, restricciones e integridad de PostgreSQL."
- S13 — "Audita el código actual y ayudame a encontrar puntos de mejora para optimizar mi backend de la app, usando las skills /nodejs-backend-patterns y" /security-audit. Interpreted as guidance-mode audit (findings + fixes in code), not report artifacts.

## Tasks

- [ ] T1 — S12, S9: baseline schema migration + hardening migration (exclusion constraint, checks, NOT NULL, tenant composite FKs, case-insensitive usuario) + migration runner + DB backup before applying. Route: inline.
- [ ] T2 — S1, S10, S11: core layer (env validation, pool, transaction helper, errors, error handler, validation middleware, CORS, rate limits, helmet, app factory, graceful shutdown). Route: inline.
- [ ] T3 — S4–S9: modules auth, empresas, citas with zod validation, bcrypt + legacy upgrade, JWT pinning + DB-backed session, admin guard, tenant scoping, atomic booking. Route: inline.
- [ ] T4 — S4–S12: integration tests (RED against baseline, GREEN after). Route: inline.
- [ ] T5 — S3, S8: app uses authenticated `GET /api/v1/empresas/actual` after login (public endpoint no longer exposes usernames). Route: inline.
- [ ] T6 — S11: `npm audit` both projects, `.env.example`, secrets check.
- [ ] T7 — S2, S3: emulator smoke test.

Route evidence: one parent session; units share core layer and contracts, so no Writer trigger reason.

## Log

- L1 (2026-10-18) — User request verbatim: "Usando buenas practicas haz que la aplicación sea mas mantenible y modular para que sea escalable al largo plazo / Utiliza un emulador para verificar los cambios en un dispositivo real, corre los procesos necesarios para lanzar este emulador si no está disponible a la primers. / Utiliza y corre el frontend ubicado en app / Inyección SQL y validación de entradas. / Autenticación, contraseñas y sesiones o tokens. / Permisos de administradores, empleados y clientes. / Aislamiento de datos entre diferentes negocios. / Acceso no autorizado a citas, clientes, servicios y empleados. / Doble reserva de un mismo horario por solicitudes simultáneas. / CORS, limitación de solicitudes y manejo de errores, según corresponda. / Dependencias vulnerables y exposición de secretos. / Transacciones, restricciones e integridad de PostgreSQL. / Revisa especialmente: Audita el código actual y ayudame a encontrar puntos de mejora para optimizar mi backend de la app, usando las skills /nodejs-backend-patterns y"
- L2 — Baseline findings (source + live schema of local `agendamiento_db`, PG 17.4):
  - F1 plaintext passwords: `authController.ts:28` compares `password_hash !== clave`; 0/1 rows bcrypt. bcryptjs installed but unused.
  - F2 double booking race: `citaController.ts:64-73` checks overlap outside the transaction; no DB constraint prevents overlaps.
  - F3 public `GET /empresas/validar/:codigo` returns every staff `usuario` (login name) to anyone with the public business code; combined with no rate limit and plaintext 4-digit passwords this enables targeted guessing.
  - F4 no rate limiting on login / code lookup / booking.
  - F5 JWT `esAdmin` trusted for 12h after demotion/deletion; algorithms not pinned; secret is 21 chars (< 32 recommended).
  - F6 input validation gaps: `2026-02-31` and `99:00 AM` pass the regexes → PostgreSQL error → 500; non-string `nombre` throws outside try → Express default HTML error page with stack; no length limits; booking outside business hours or crossing midnight accepted.
  - F7 integrity: `clientes` unique is `(empresa_id, telefono)` but lookup uses `indicativo` too → same phone with another country code = 500; nullable `empresa_id`/FK columns; no CHECK on `estado`, prices, durations; tenant consistency of `citas.barbero_id/servicio_id/cliente_id` only enforced in app code; `usuario` unique is case-sensitive while login is case-insensitive.
  - F8 `cors()` open to every origin; no helmet; no central error handler (malformed JSON returns HTML stack); no `.gitignore` (`.env` with DB password and JWT secret unprotected from accidental commit).
  - SQL injection: all queries parameterized; the only interpolation (`filtroBarbero`) is a constant. No finding.
