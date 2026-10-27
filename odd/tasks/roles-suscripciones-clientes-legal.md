# Equal admins, team roles and limit, subscriptions, client accounts and data-processing consent

Objective: equal permissions for both admin types, team roles + "atiende clientes" + member limit, employee restrictions, cartera filter, subscription plans with dev commands, optional client accounts (saved businesses, own bookings), Ley 1581 consent with proof and draft legal texts. Backend only.
Branch: `feature/registro-empresa` (base `eaec5d8`). Delivery: single branch, work-unit commits, push authorized by the user. Test runner: none for this feature (user: "No escribas pruebas automáticas ni pidas revisiones"); checks are manual HTTP calls against the local server with `PRUEBA*` data removed afterwards, plus `npm run typecheck`.

## Specs

- S1 — "Administradores: hay dos tipos de admin (la cuenta de correo de la empresa y los miembros del equipo marcados como admin). Ambos deben tener los mismos permisos sobre su empresa: Mi negocio, equipo, servicios, productos, bloqueos, clientes y la cartera completa."
- S2 — "Al crear o editar un integrante se elige su rol: "Administrador" o "Empleado". Además, una opción "Atiende clientes" (para que un admin también pueda recibir reservas como profesional)."
- S3 — "Límite: no se pueden tener más integrantes activos que el número de empleados registrado por la empresa (máximo 10). Si se alcanza, responde con un mensaje claro que diga que debe aumentar el número en Mi negocio."
- S4 — "Empleados (no admin): solo pueden usar su agenda y su propia cartera. No pueden ver ni usar bloqueos."
- S5 — "Cartera: un admin ve la cartera de todo el negocio y puede filtrar por cada integrante, incluido él mismo. Un empleado ve solo la suya."
- S6 — "Estados: prueba, activa (plan mensual o anual) y vencida." / "Guarda el plan, la fecha de pago y la fecha de fin de la suscripción." / "Un endpoint que devuelva el estado, el plan, la fecha de pago, la fecha de fin y los días restantes (calculados con la fecha actual de Colombia, para que bajen cada día)." / "Que indique si debe mostrarse un recordatorio: siempre durante la prueba, y en los últimos 7 días de un plan mensual o anual."
- S7 — "Cuando está vencida: el admin puede iniciar sesión y usar Mi negocio y la consulta de suscripción, pero no el resto; los empleados reciben un aviso de negocio inactivo; los clientes no pueden reservar y reciben "Este negocio no está recibiendo reservas por ahora"."
- S8 — "NO integres pagos reales. Crea un comando de desarrollador para activar un plan a una empresa, por ejemplo: npm run dev:activar-plan -- CODIGO mensual"
- S9 — "Comando para probar el vencimiento (solo en desarrollo): npm run dev:simular-vencimiento -- CODIGO DIAS, que deje a la empresa con esa cantidad de días restantes (0 o negativo = vencida). Que no funcione en producción."
- S10 — "Un cliente puede crear cuenta (nombre, teléfono, correo o usuario y contraseña) e iniciar sesión con el login único." / "Puede guardar negocios usando su código y ver la lista de sus negocios guardados, para no escribir el código cada vez." / "Al reservar con sesión, se usan su nombre y teléfono automáticamente, y puede ver sus citas." / "Reservar sin cuenta (como invitado, con código, enlace o QR) debe seguir funcionando igual."
- S11 — "El registro de empresa, el registro de cliente y la reserva como invitado deben exigir la aceptación de la Política de Tratamiento de Datos y de los Términos y Condiciones. Rechaza el registro o la reserva si no viene aceptada." / "Un cliente con cuenta que ya aceptó NO debe volver a aceptar al reservar desde su sesión. Solo se le pide de nuevo si se publica una versión nueva de la política o de los términos." / "Guarda la prueba de cada autorización: quién (o qué teléfono si es invitado), fecha y hora, desde dónde (registro empresa, registro cliente o reserva) y la versión del documento aceptado." / "Crea endpoints públicos que devuelvan el texto vigente de la política y de los términos, con su versión."
- S12 — "Redacta un BORRADOR de la Política de Tratamiento de Datos y de los Términos y Condiciones según la Ley 1581 de 2012 y el Decreto 1377 de 2013, solo para pruebas. Marca claramente "BORRADOR – PENDIENTE DE REVISIÓN LEGAL" al inicio. Donde falten datos reales (nombre del responsable, NIT, correo de contacto, dirección), deja espacios como [NOMBRE DEL RESPONSABLE]; no inventes datos."
- S13 — "Actualiza AGENTS.md con todos los cambios y explica cómo usar los dos comandos de desarrollador." / "Haz commit y push. Dame un resumen sencillo."

Assumptions (no open product decision; recorded so they can be changed later):
- A1 — Stored state keeps `trial` / `activa` / `vencida` / `cancelada`; the effective state is derived from dates (no scheduled job): expired when the end date (Colombia) is today or earlier. `cancelada` is reported as `vencida`. Existing `activa` companies without a plan stay active with no end date.
- A2 — `dev:activar-plan` extends from the current end date when the plan is still running, otherwise from today. It is allowed in production (manual activation while there are no payments); only `dev:simular-vencimiento` is blocked there.
- A3 — A new member defaults to "atiende clientes" = true for employees and false for admins; existing members keep receiving bookings (true). A member that does not attend clients is hidden from the public booking data and cannot be booked.
- A4 — Lowering "número de empleados" in Mi negocio below the active team is rejected (409), so the S3 invariant cannot be bypassed. Companies already over the limit keep their team; they just cannot add more.
- A5 — Employees whose business is expired get 402 with the inactive-business notice at login and on every staff endpoint. `/empresas/actual` stays available (same data as the public `/empresas/validar/:codigo`).
- A6 — Employees lose `GET /bloqueos` and `GET /servicios` (S4: "solo pueden usar su agenda y su propia cartera").
- A7 — Client accounts may also remove a saved business (DELETE), the natural complement of "guardar".
- A8 — Legal texts live in the database (`documentos_legales`), one row per published version; a new version is a new migration. Consent proof (`autorizaciones_datos`) stores both versions accepted together; it is deleted with the account or business it belongs to.
- A9 — On `POST /citas`, only a valid client-account token changes the flow; any other token (staff, admin, expired) is ignored and the request is a guest booking, so guest booking keeps working.

## Tasks

- [x] T1 — S1–S5: migration 009 (team), equal admins, roles, limit, employee restrictions, cartera filter. Route: inline. Commit: feat commit (L3).
- [x] T2 — S6–S9: subscription columns, effective state, endpoint, expired behaviour, dev commands. Route: inline. Commit: feat commit (L3).
- [x] T3 — S10–S12: client accounts, saved businesses, own bookings, consent + legal drafts (migration 010). Route: inline. Commit: feat commit (L3).
- [x] T4 — S13: AGENTS.md, manual checks, cleanup, commit, push. Route: inline. Commit: docs commit (L3).

Route evidence: one parent session; tasks share migration 009, the auth/session code and the citas module, so there is no independent parallel unit (no Writer reason).

## Log

- L1 (2026-10-19, user request, verbatim):

> 1. Administradores: hay dos tipos de admin (la cuenta de correo de la empresa y los miembros del equipo marcados como admin). Ambos deben tener los mismos permisos sobre su empresa: Mi negocio, equipo, servicios, productos, bloqueos, clientes y la cartera completa.
>
> 2. Equipo:
>    - Al crear o editar un integrante se elige su rol: "Administrador" o "Empleado". Además, una opción "Atiende clientes" (para que un admin también pueda recibir reservas como profesional).
>    - Límite: no se pueden tener más integrantes activos que el número de empleados registrado por la empresa (máximo 10). Si se alcanza, responde con un mensaje claro que diga que debe aumentar el número en Mi negocio.
>
> 3. Empleados (no admin): solo pueden usar su agenda y su propia cartera. No pueden ver ni usar bloqueos.
>
> 4. Cartera: un admin ve la cartera de todo el negocio y puede filtrar por cada integrante, incluido él mismo. Un empleado ve solo la suya.
>
> 5. Suscripciones:
>    - Estados: prueba, activa (plan mensual o anual) y vencida.
>    - Guarda el plan, la fecha de pago y la fecha de fin de la suscripción.
>    - Un endpoint que devuelva el estado, el plan, la fecha de pago, la fecha de fin y los días restantes (calculados con la fecha actual de Colombia, para que bajen cada día).
>    - Que indique si debe mostrarse un recordatorio: siempre durante la prueba, y en los últimos 7 días de un plan mensual o anual.
>    - Cuando está vencida: el admin puede iniciar sesión y usar Mi negocio y la consulta de suscripción, pero no el resto; los empleados reciben un aviso de negocio inactivo; los clientes no pueden reservar y reciben "Este negocio no está recibiendo reservas por ahora".
>    - NO integres pagos reales. Crea un comando de desarrollador para activar un plan a una empresa, por ejemplo: npm run dev:activar-plan -- CODIGO mensual
>
> 6. Comando para probar el vencimiento (solo en desarrollo): npm run dev:simular-vencimiento -- CODIGO DIAS, que deje a la empresa con esa cantidad de días restantes (0 o negativo = vencida). Que no funcione en producción.
>
> 7. Clientes registrados (opcional para el cliente):
>    - Un cliente puede crear cuenta (nombre, teléfono, correo o usuario y contraseña) e iniciar sesión con el login único.
>    - Puede guardar negocios usando su código y ver la lista de sus negocios guardados, para no escribir el código cada vez.
>    - Al reservar con sesión, se usan su nombre y teléfono automáticamente, y puede ver sus citas.
>    - Reservar sin cuenta (como invitado, con código, enlace o QR) debe seguir funcionando igual.
>
> 8. Autorización de tratamiento de datos (Ley 1581 de 2012):
>    - El registro de empresa, el registro de cliente y la reserva como invitado deben exigir la aceptación de la Política de Tratamiento de Datos y de los Términos y Condiciones. Rechaza el registro o la reserva si no viene aceptada.
>    - Un cliente con cuenta que ya aceptó NO debe volver a aceptar al reservar desde su sesión. Solo se le pide de nuevo si se publica una versión nueva de la política o de los términos.
>    - Guarda la prueba de cada autorización: quién (o qué teléfono si es invitado), fecha y hora, desde dónde (registro empresa, registro cliente o reserva) y la versión del documento aceptado.
>    - Crea endpoints públicos que devuelvan el texto vigente de la política y de los términos, con su versión.
>    - Redacta un BORRADOR de la Política de Tratamiento de Datos y de los Términos y Condiciones según la Ley 1581 de 2012 y el Decreto 1377 de 2013, solo para pruebas. Marca claramente "BORRADOR – PENDIENTE DE REVISIÓN LEGAL" al inicio. Donde falten datos reales (nombre del responsable, NIT, correo de contacto, dirección), deja espacios como [NOMBRE DEL RESPONSABLE]; no inventes datos.
>
> 9. Actualiza AGENTS.md con todos los cambios y explica cómo usar los dos comandos de desarrollador.
>
> Haz commit y push. Dame un resumen sencillo.

- L2 — Baseline: SHAMPO has 3 active members with `numero_empleados = 2` (already over the new limit; see A4). INFINITY is `activa` without plan (A1). Only 2 admin accounts, no client accounts.
- L3 — Evidence (2026-10-19): `npm run db:migrate` applied 009 and 010; `npm run typecheck` passes. Manual HTTP checks against the local server with `PRUEBA*` data (company PRUEBA1, client `prueba.cli`), all as expected: legal endpoints (S11); company/client registration rejected without acceptance (S11); team roles, `atiendeClientes` defaults, limit 409 messages, Mi negocio rejecting fewer employees than the active team (S2, S3, A4); team admin using Mi negocio, subscription, blocks, services (S1); employee 403 on blocks/services/Mi negocio, 200 on agenda (S4); public view hides non-attending members and booking them is 404 (A3); guest booking needs acceptance, proof row stored with phone/cita (S11); client account with username only, unified login `tipo: cliente`, save/list businesses, booking with session using account name/phone without re-accepting, own bookings list (S10); cartera filter for admin, own for employee (S5); a temporary new policy version made the client accept once, then not again (S11); `dev:simular-vencimiento` 3/5/0/-2 and `dev:activar-plan` mensual/anual (renewal extended from the current end), reminder flags, expired behaviour for admin (Mi negocio 200, rest 402), employees (402 at login and endpoints), clients (403), `recibiendoReservas: false` (S6–S9); `NODE_ENV=production` refused (S9). Bug found and fixed during checks: `activarPlan` parameter type inference (`$2::varchar`). All PRUEBA data and the temporary version were deleted; real companies unchanged (INFINITY activa without plan, R8Y4DP and SHAMPO in trial, 14 days). Not run: `npm test` (user asked for no automated tests); the existing integration tests predate these contract changes (acceptance required on registration, client registration body, client 403 on unified login, employee access to blocks/services) and need updating.
- L4 — Delivery: one feat commit (code + migrations, units share files such as `empresas.servicio.ts` and `citas.servicio.ts`, so they were not split) and one docs commit, then push.
