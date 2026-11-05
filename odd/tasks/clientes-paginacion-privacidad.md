# Client list pagination and employee phone privacy

Objective: optional cursor pagination and search for `GET /clientes`; a per-business switch that decides whether employees receive client phone numbers.
Branch: `feat/clientes-paginacion-privacidad` (base `45b5b9b`). Delivery: one commit per task, no push (user). Test runner: `npm test` (node:test, temporary databases) and `npm run typecheck`.

## Specs

- S1 — "Paginación de GET /api/v1/clientes: parámetros opcionales limite (por defecto 20, máximo 50), cursor y q (búsqueda por nombre o teléfono). Sin parámetros funciona como hoy."
- S2 — "Opción del negocio "los empleados pueden ver el teléfono de los clientes", apagada por defecto (migración nueva, una columna en la empresa). Solo el administrador la puede cambiar, desde un endpoint nuevo."
- S3 — "SEGURIDAD: si está apagada, el backend NO debe enviar el teléfono ni el enlace de WhatsApp de los clientes a un empleado, en ninguna ruta (clientes, citas, agenda, notificaciones, búsquedas). Si está encendida, sí. Los administradores siempre lo ven. Agrega pruebas que demuestren que apagada no se filtra en ninguna respuesta."
- S4 — "En las pruebas de barrido, incluye el caso de cambiar la opción de apagada a encendida y de encendida a apagada, y comprueba que el cambio se nota de inmediato para el empleado, sin esperar ni reiniciar."
- S5 — "Antes de crear la migración 034, comprueba que ninguna otra rama o PR pendiente (por ejemplo la de clientes filtrados por empleado) use ese mismo número. Si hay riesgo de choque, dímelo."
- S6 — "B es riesgo alto (datos personales): usa verificador independiente. No apliques la migración sobre datos reales sin avisarme. Actualiza docs/. Explícame qué hace cada cambio." / "Sin push."

Decisions confirmed by the user (L2):
- D1 — Hidden phone is sent as `telefono: null` (and `indicativo: null`), the field is kept.
- D2 — `GET /clientes` stays admin-only (employees keep getting 403).
- D3 — With any of `limite`, `cursor` or `q` the response is `{ datos, siguienteCursor }`; without them, the same array as today.

## Tasks

- [x] T0 — S5: migration number check. Route: inline. Evidence in L3.
- [ ] T1 — S1: pagination + search in `GET /clientes`. Route: inline (single unit, no Writer trigger). Commit: pending.
- [ ] T2 — S2: migration 034 + `GET`/`PUT /admin/empresa/privacidad-clientes`. Route: inline. Commit: pending.
- [ ] T3 — S3, S4: hide phone for employees in every employee-reachable response + sweep tests. Route: inline; independent verifier after (Risk item 2). Commit: pending.
- [ ] T4 — S6: docs (AGENTS.md, README.md). Bundled with each task's commit.

## Log

- L1 (2026-11-05, user): "Antes de empezar, dime tu plan en español sencillo. Rama nueva desde main actualizado, con un commit por tarea. A) Paginación de GET /api/v1/clientes: parámetros opcionales limite (por defecto 20, máximo 50), cursor y q (búsqueda por nombre o teléfono). Sin parámetros funciona como hoy. B) Opción del negocio "los empleados pueden ver el teléfono de los clientes", apagada por defecto (migración nueva, una columna en la empresa). Solo el administrador la puede cambiar, desde un endpoint nuevo. SEGURIDAD: si está apagada, el backend NO debe enviar el teléfono ni el enlace de WhatsApp de los clientes a un empleado, en ninguna ruta (clientes, citas, agenda, notificaciones, búsquedas). Si está encendida, sí. Los administradores siempre lo ven. Agrega pruebas que demuestren que apagada no se filtra en ninguna respuesta. B es riesgo alto (datos personales): usa verificador independiente. No apliques la migración sobre datos reales sin avisarme. Actualiza docs/. Explícame qué hace cada cambio."
- L2 (2026-11-05, user): "Sí, arranca con tu plan. Dos ajustes: 1) Antes de crear la migración 034, comprueba que ninguna otra rama o PR pendiente (por ejemplo la de clientes filtrados por empleado) use ese mismo número. Si hay riesgo de choque, dímelo. 2) En las pruebas de barrido, incluye el caso de cambiar la opción de apagada a encendida y de encendida a apagada, y comprueba que el cambio se nota de inmediato para el empleado, sin esperar ni reiniciar. Como pediste, no apliques la migración sobre agendamiento_db sin avisarme. Sin push."
- L3 (T0): no local branch, remote branch or PR head (refs/pull/1..13) contains a migration numbered 034 or higher. Local-only branch `feat/clientes-panel-empleado` (commit 7e6e561, unpushed) adds no migration, but adds `GET /citas/panel/clientes`, which returns `telefono`/`indicativo` to employees: if merged after this feature it must apply the same phone rule. It also edits `crearDesdePanel` in `citas.servicio.ts` (likely text conflict).
- L4: employee-reachable responses with client phones at base: `GET /citas/agenda` (`telefono`) and `POST /citas/panel` (`cita.telefono`, `cita.indicativo`). Notifications carry no phone; no client WhatsApp link exists.
