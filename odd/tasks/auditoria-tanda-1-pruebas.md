# Audit batch 1 — test suite repair (finding A-1)

Objective: make the automated tests run again, safely, and cover the critical gaps listed in `docs/auditoria/informe-backend.md` (A-1 and section E). Backend only; no production code changes.
Branch: `auditoria`. Delivery: exception-ok (work-unit commits on `auditoria`, push at the end). Test runner: `tsx --test --test-concurrency=1 "test/**/*.test.ts"` (node:test), one disposable PostgreSQL database per test file.

## Specs

- S1 — "Las pruebas NUNCA deben usar la base de desarrollo agendamiento_db. Configura una base separada para pruebas (por ejemplo agendamiento_test) con su propia variable de entorno, y que las pruebas se nieguen a correr si apuntan a agendamiento_db. Como no puedes leer el .env, explícame paso a paso qué debo crear en PostgreSQL y qué línea agregar al .env."
- S2 — "Cuando yo confirme que la base de pruebas está lista, actualiza los ayudantes de prueba (test/apoyo/servidor.ts y los demás) para que todas las pruebas vuelvan a correr."
- S3 — "Actualiza las pruebas que fallan por reglas que cambiaron a propósito (registro, roles, planes, zona horaria, autorizaciones) sin debilitar lo que comprueban."
- S4 — "Agrega pruebas para lo crítico que no tenga: que un negocio no pueda ver ni modificar datos de otro, permisos por rol, cálculo de horas disponibles (incluido el almuerzo), dos reservas simultáneas a la misma hora, cobros proporcionales y niveles, y zona horaria."
- S5 — "Ejecuta todas las pruebas y dime cuántas pasan. Si alguna falla por un error real del código (no de la prueba), NO lo arregles: anótalo en el informe para la siguiente tanda."
- S6 — "Commit y push. Resumen corto."

## Tasks

- [x] T1 — S1 (evidence: RED `ERR_MODULE_NOT_FOUND` before the guard existed; GREEN 7/7 in `test/guardiaBaseDePrueba.test.ts`; `npm run typecheck` clean; DB suites refuse without `TEST_DB_NAME`; commit hash recorded with T2): `TEST_DB_NAME` guard (`test/apoyo/configuracionPruebas.ts`), test helper uses only the test database settings, unit test for the guard, AGENTS.md notes, user instructions for PostgreSQL and `.env`. Route: inline.
- [ ] T2 — S2: WAIT for the user's confirmation, then update `test/apoyo/*` to the current API. Route: inline.
- [ ] T3 — S3: update the stale tests. Route: inline.
- [ ] T4 — S4: add the missing critical tests. Route: inline.
- [ ] T5 — S5, S6: full run, record real code defects in the report, commit, push. Route: inline.

## Log

- L1 (2026-10-23, user, verbatim): "Solo BACKEND. Sigue AGENTS.md (el servidor ya está encendido; no lo inicies ni lo apagues). Trabaja en la rama auditoria. Explícame en lenguaje sencillo. Basado en docs/auditoria/informe-backend.md. Tanda 1 – hallazgo A-1 (pruebas): 1. Las pruebas NUNCA deben usar la base de desarrollo agendamiento_db. Configura una base separada para pruebas (por ejemplo agendamiento_test) con su propia variable de entorno, y que las pruebas se nieguen a correr si apuntan a agendamiento_db. Como no puedes leer el .env, explícame paso a paso qué debo crear en PostgreSQL y qué línea agregar al .env. 2. Cuando yo confirme que la base de pruebas está lista, actualiza los ayudantes de prueba (test/apoyo/servidor.ts y los demás) para que todas las pruebas vuelvan a correr. 3. Actualiza las pruebas que fallan por reglas que cambiaron a propósito (registro, roles, planes, zona horaria, autorizaciones) sin debilitar lo que comprueban. 4. Agrega pruebas para lo crítico que no tenga: que un negocio no pueda ver ni modificar datos de otro, permisos por rol, cálculo de horas disponibles (incluido el almuerzo), dos reservas simultáneas a la misma hora, cobros proporcionales y niveles, y zona horaria. 5. Ejecuta todas las pruebas y dime cuántas pasan. Si alguna falla por un error real del código (no de la prueba), NO lo arregles: anótalo en el informe para la siguiente tanda. Commit y push. Resumen corto."
- L2: Baseline from the audit: 96 tests, 36 pass, 30 fail, 30 cancelled; causes are stale helpers (`nit`, missing `codigoAcceso`, missing `aceptaPoliticaDatos`/`aceptaTerminos`), not code defects.
- L3: Design for T1. The suite already creates one throw-away database per test file. The new `TEST_DB_NAME` (e.g. `agendamiento_test`) is the maintenance database the suite connects to in order to create and drop those throw-away databases, named `<TEST_DB_NAME>_<pid>_<time>`. The suite no longer reads the development `DB_NAME`. It refuses to run when `TEST_DB_NAME` is missing, equals `agendamiento_db` or the development `DB_NAME`, or does not contain `test` or `prueba`. Optional `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER`, `TEST_DB_PASSWORD` fall back to the `DB_*` server settings.
