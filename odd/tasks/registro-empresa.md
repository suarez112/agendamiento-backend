# Company registration, client accounts, 15-day trial and roles

Objective: registration and login endpoints for companies (with their admin account) and clients, a 15-day free trial that blocks admin endpoints when it ends, and role rules for `usuarios` (migration 003). Backend only.
Branch: `feature/registro-empresa` (base `820b0b1`). Delivery: single branch, work-unit commits, push authorized by the user. Test runner: `tsx --test` (node:test) with a disposable PostgreSQL database per file.

## Specs

- S1 — "Registro de empresa (crea la empresa y su usuario administrador) con validaciones: campos obligatorios, hora de cierre después de la apertura, número de empleados positivo, correo válido."
- S2 — "Registro y login de cliente."
- S3 — "Al registrar la empresa, guarda trial_ends_at = fecha actual + 15 días."
- S4 — "Crea un middleware que bloquee los endpoints de administrador cuando la prueba venció, con un mensaje de error claro."
- S5 — "Crea un endpoint que devuelva cuántos días de prueba le quedan a la empresa."
- S6 — "Un admin solo puede ver y modificar los datos de su propia empresa."
- S7 — "Un cliente no puede acceder a endpoints de administrador."
- S8 — "Actualiza AGENTS.md con los nuevos endpoints: método, ruta, qué datos recibe y qué responde. El frontend dependerá de esta lista."
- S9 — "Ejecuta las pruebas, haz commit y push de la rama." Constraints: "Haz únicamente la parte de backend"; "si necesitas cambiar el esquema, crea una migración 004 y no edites la 003".

Assumptions (no open product decision; recorded so they can be changed later):
- A1 — The admin logs in with the company `correo` and the `clave` sent at registration (one login endpoint for admin and client accounts).
- A2 — An expired trial answers HTTP 402 so the app can tell "trial ended" apart from "not allowed" (403).
- A3 — The days-left endpoint stays available after the trial ends (it must be able to answer "0 days").
- A4 — The trial guard also covers the existing staff admin endpoint `PATCH /citas/:id/cancelar`; existing companies are `activa`, so they are unaffected.

## Tasks

- [x] T1 — S1, S2, S3, S7: `cuentas` module (company registration + admin account, client registration, account login, account tokens/session). Route: inline. Commit `c45aa89`.
- [x] T2 — S4, S5, S6, S7: admin company endpoints (view, update, trial days), trial guard, role guard. Route: inline. Commit `9e35d2f`.
- [x] T3 — S8, S9: AGENTS.md/README endpoint contract, full suite, commit, push. Route: inline. Commits `9e35d2f` + docs follow-up; push recorded in L8.

Route evidence: one parent session; T2 depends on T1's session/guards, so no parallel Writer reason.

## Log

- L1 (2026-10-18) — User request verbatim: "Este proyecto es solo el BACKEND. Haz únicamente la parte de backend. El frontend está en C:\Users\eduar_9\app; no lo modifiques. Continúa en la rama feature/registro-empresa. Lee AGENTS.md primero. La migración 003 ya está aplicada en la base local; si necesitas cambiar el esquema, crea una migración 004 y no edites la 003. Explícame lo que hagas en lenguaje sencillo, porque tengo poco conocimiento de programación. 1. Endpoints de registro: - Registro de empresa (crea la empresa y su usuario administrador) con validaciones: campos obligatorios, hora de cierre después de la apertura, número de empleados positivo, correo válido. - Registro y login de cliente. 2. Prueba gratuita de 15 días: - Al registrar la empresa, guarda trial_ends_at = fecha actual + 15 días. - Crea un middleware que bloquee los endpoints de administrador cuando la prueba venció, con un mensaje de error claro. - Crea un endpoint que devuelva cuántos días de prueba le quedan a la empresa. 3. Roles: - Un admin solo puede ver y modificar los datos de su propia empresa. - Un cliente no puede acceder a endpoints de administrador. 4. Actualiza AGENTS.md con los nuevos endpoints: método, ruta, qué datos recibe y qué responde. El frontend dependerá de esta lista. Ejecuta las pruebas, haz commit y push de la rama. Muéstrame un resumen sencillo. No continúes con más tareas."
- L2 — Exploration: migration 003 already has every needed column (`empresas` profile + `trial_ends_at` + `estado_suscripcion`, `usuarios` with `rol`/`empresa_id`), so no migration 004 is planned. Existing staff login (`barberos`) and its token format stay unchanged; account tokens carry `tipo: 'cuenta'` and staff verification rejects them.
- L3 — T1 RED: `test/cuentas.test.ts` 15 tests, 0 pass (routes 404, client suite setup failed). GREEN: 15/15 after the `cuentas` module; `npm run typecheck` exit 0.
- L4 — T2 RED: `test/adminEmpresa.test.ts` 13 tests, 13 fail. GREEN: 13/13 after admin routes + guards. Full suite: first run 95/96 (one failure, not captured; output not saved), then 10 consecutive runs 96/96 — not reproduced.
- L5 — Smoke against the local DB (schema_migrations 001,002,003; read-only requests): server boots, `/api/saludo` 200, `/admin/empresa/prueba` without token 401, incomplete registration 400 with field message, unknown login 401. No migration 004 created.
- L6 — Risk: item 2 (new login, account tokens, role and trial guards) and item 3 (`PATCH /citas/:id/cancelar` now also answers 402 when the subscription is not active; staff token verification now rejects tokens carrying `tipo`). Independent verifier required.
- L7 — Independent verifier over 820b0b1..9e35d2f: S1–S8 PASS, 0 blockers; typecheck exit 0; npm test 96/96; differential of 24 staff-endpoint requests at 820b0b1 vs HEAD identical except the canceladaEn timestamp. Advisories (not fixed, out of requested scope): shared per-IP login limiter for staff and account logins; days-left could read 16 right after registration only if the DB session time zone has daylight saving (Colombia/UTC unaffected); company contact correo is not unique after PATCH (by design); cancel checks 402 before 404. Contract gap fixed in AGENTS.md: client registration 400 messages for missing body and missing correo.
- L8 — Pushed `feature/registro-empresa` to origin (820b0b1..57e1108). Native review (RDD on), consent granted by the user twice: (a) 820b0b1..57e1108, lenses risk/readability/reliability → approved, acknowledged (lineage `review-fc9092a0783903e8`); (b) whole branch vs main 0bdaeb6..57e1108, four lenses → approved after relaunching three reviewer slots that first failed on the model provider session limit, acknowledged (lineage `review-6c463d192a045512`). 0 blockers. Non-blocking findings for later: registration 409 reveals whether an email has an account; staff and account logins share one per-IP failed-attempt limiter; the registration limiter counts every request (also 400s and successes); PATCH /citas/:id/cancelar answers 402 before 400/404 for non-active companies; DST could show 16 trial days if the DB time zone uses daylight saving; the first 95/96 suite failure was not captured; access-code retry and registration limiter have no dedicated tests.
