# Informe de auditoría del backend (agendamiento-backend)

- **Fecha:** 2026-10-23
- **Rama auditada:** `feature/registro-empresa` (commit `c6dbdfb`), revisada desde la rama `auditoria`
- **Alcance:** solo el backend. No se modificó código, pruebas ni dependencias; este archivo es lo único nuevo.
- **Cómo leer este informe:** cada hallazgo tiene gravedad, qué es en palabras sencillas, dónde está y cómo se arreglaría. Van de más grave a menos grave. Al final hay una tabla resumen.

## Resumen para quien no programa

- **No encontré ningún hallazgo Crítico**: no hay una forma, que yo haya podido comprobar en el código, de que alguien sin cuenta robe la base de datos o tome cuentas ajenas.
- **Lo que mejor está hecho:** un negocio no puede ver ni modificar datos de otro (cada consulta filtra por el negocio de la sesión y, además, la base de datos lo impone con llaves compuestas); las contraseñas nuevas se guardan con bcrypt; el SQL es parametrizado; las fotos se procesan y se sirven de forma segura; los secretos nunca se subieron a GitHub.
- **Lo más urgente:**
  1. **Las pruebas automáticas están rotas** (60 de 96 no pasan o se cancelan) y justo las que vigilan el aislamiento entre negocios, los permisos y las reservas simultáneas son las que no corren. Hoy nada avisaría si alguien rompe esas reglas.
  2. **Cualquiera puede llenar la agenda de un negocio con reservas falsas** (no hay verificación del teléfono).
  3. **La aplicación se conecta a la base de datos con el usuario `postgres`** (superusuario).
  4. Los límites de intentos (login, registro) cuentan **solo por IP** y se comparten entre pantallas; en redes móviles con IP compartida pueden bloquear a gente inocente y no frenan a un atacante con muchas IP.

## Cómo se hizo la revisión (y sus límites)

**Pruebas y base de datos.** Antes de ejecutar las pruebas verifiqué qué base usan: **no tocan `agendamiento_db`**. Cada archivo de prueba crea una base temporal con nombre único (`agendamiento_prueba_<proceso>_<hora>`, en `test/apoyo/baseDePrueba.ts:50`), la migra, la llena con datos falsos y al terminar borra solo esa base (`DROP DATABASE … "<nombre temporal>"`). Se conectan a la base `postgres` únicamente para crear y borrar la temporal. Por eso las ejecuté. Recomendación (no urgente) al final de la sección E.

**Leído completo:** `app.ts`, `server.ts`, `entorno.ts`, `pool.ts`, `limitadores.ts`, `cors.ts`, `registro.ts`, `manejadorErrores.ts`, `tokens.ts`, `guardias.ts`, `permisos.ts`, `auth.servicio.ts`, `acceso.ts`, `contrasenas.ts`, `cuentas.servicio.ts`, `cuentas.rutas.ts`, `cuentas.guardias.ts`, `recuperacion.servicio.ts`, `eliminacion.servicio.ts`, `fotos.ts`, `totp.ts`, `superadmin.rutas.ts` (parte inicial), `superadmin.servicio.ts` (primeras 260 líneas), `legal.ts` (primeras 130 líneas), `citas.rutas.ts`, `citas.servicio.ts` (reserva), `citas.repositorio.ts` (parte central), `push.ts`, `correo.ts`, `suscripcion.ts`, `dispositivos.rutas.ts`.

**Revisado con búsquedas dirigidas (no línea por línea):** consultas SQL de equipo, clientes, bloqueos, productos, servicios, cartera y reportes (verifiqué que todas lleven el negocio de la sesión), uso de los limitadores en todas las rutas, registros (`registro.*`), SQL construido con texto, historial de git.

**No revisé a fondo:** `empresas.servicio.ts`, `pqrs.*`, `notificaciones.repositorio.ts`, `micuenta.repositorio.ts`, `exportacion.ts` y el resto de `superadmin.servicio.ts`/`superadmin.repositorio.ts`. Una auditoría completa debería cubrirlos.

**No pude comprobar** (no leí `.env`, el sistema lo bloqueó): con qué usuario se conecta realmente la base ni los valores de `NODE_ENV`, `TRUST_PROXY` y `CORS_ORIGINS`. Para el usuario de la base me apoyo en `AGENTS.md` (que dice que la app se conecta como `postgres`) y en que las pruebas pudieron crear bases (eso exige permiso `CREATEDB`). Tampoco probé nada contra servidores en línea.

**Verificaciones que sí salieron bien:** `npm run typecheck` pasa sin errores; el código no usa `any`; el historial de git (122 commits, todas las ramas) no contiene `.env`, contraseñas ni claves reales.

---

# HALLAZGOS

## ALTO

### A-1. Las pruebas que protegen lo más importante no están funcionando
- **Estado: RESUELTO en la tanda 1 (2026-10-25).** Hoy corren las **211 pruebas y las 211 pasan**; ver "SEGUIMIENTO – TANDA 1" al final. Lo que sigue describe el problema original.
- **Qué es:** corrí las 96 pruebas: **36 pasan, 30 fallan y 30 se cancelan**. No fallan porque el programa esté roto, sino porque **las pruebas quedaron viejas** frente a cambios posteriores de la API. En cada archivo, la preparación registra un negocio de prueba con datos antiguos y la API ahora responde 400 (falta el código del negocio, la aceptación de la política y los términos, o se envía el campo `nit`, que ya no existe). Al fallar la preparación, todas las pruebas de ese archivo se cancelan.
- **Qué deja sin vigilancia:** aislamiento entre negocios y permisos (`permisos.test.ts`), 20 reservas simultáneas por la misma hora (`reservas.test.ts`), validación de reservas, suscripciones y prueba gratuita (`adminEmpresa.test.ts`), registro de empresa y de clientes (`cuentas.test.ts`, `registroEmpresa.test.ts`). Las que sí pasan: autenticación, límite de login, manejo de errores, CORS y conversión de horas.
- **Causas concretas:**
  - `test/adminEmpresa.test.ts:29-30` registra con `nit` (campo eliminado en la migración 007) y sin código de negocio.
  - `test/apoyo/servidor.ts:152` (`reservaValida`) no envía `aceptaPoliticaDatos` ni `aceptaTerminos`: la reserva devuelve 400 *«Debes aceptar la Política…»*.
  - Los datos de prueba chocan con las restricciones nuevas (`empresas_codigo_acceso_valido`, `usuarios_admin_con_usuario`, columna `nit` inexistente).
- **Cómo se arregla:** actualizar los ayudantes de `test/apoyo/` y los datos de partida al contrato actual (código de negocio, usuario de la administradora, aceptaciones). Es un arreglo pequeño y de mucho valor. Después, que `npm test` corra en cada cambio (hoy no hay integración continua: no existe `.github/`).

### A-2. Reservas falsas de invitados: no hay verificación del teléfono
- **Estado: RESUELTO en la tanda 3 (2026-10-26). Máximo de 3 citas pendientes por teléfono y negocio (invitados y clientes con cuenta; configurable con `MAX_CITAS_PENDIENTES`) y un tope de 15 reservas guardadas por hora y por conexión, sin SMS ni WhatsApp. Ver "SEGUIMIENTO – TANDA 3".**
- **Qué es:** cualquiera puede reservar como invitado con **cualquier teléfono y cualquier nombre**, sin confirmar que el número sea suyo. El único freno es 20 reservas cada 15 minutos por IP. Con varias IP (o una red móvil) se puede ocupar la agenda completa de un profesional durante los 14 días permitidos, y cada reserva además dispara una notificación al administrador y crea filas de cliente y de auditoría (la base crece sin tope).
- **Dónde:** `src/modules/citas/citas.rutas.ts:23`, `src/modules/citas/citas.servicio.ts:38-135` y `src/shared/http/limitadores.ts:30` (`reservas: 20`). No hay tope de citas pendientes por teléfono, por día ni por negocio.
- **Impacto real:** el negocio no puede atender clientes de verdad y no tiene forma sencilla de saber cuáles reservas son falsas (solo puede cancelarlas una por una o poner el número en la lista negra).
- **Cómo se arregla (de menor a mayor esfuerzo):**
  1. Máximo de citas pendientes por teléfono y por negocio (por ejemplo 2) y un tope de reservas nuevas por negocio por hora.
  2. Límite por negocio además del límite por IP.
  3. Confirmar el teléfono con un código (SMS o WhatsApp) antes de dejar la cita en `CONFIRMADA`, o pedir cuenta de cliente para reservar.
  4. Una verificación de aplicación legítima (por ejemplo App Attest / Play Integrity) o CAPTCHA en la versión web.

### A-3. La aplicación se conecta a PostgreSQL con el usuario `postgres`
- **Estado: RESUELTO en la tanda 2 (2026-10-26).** La app usa el rol limitado `agendamiento_app`; ver "SEGUIMIENTO – TANDA 2" al final. Lo que sigue describe el problema original.
- **Qué es:** `postgres` es el superusuario: puede leer, cambiar y borrar todo, crear bases y, en muchas instalaciones, ejecutar comandos en el servidor de la base. La app solo necesita leer y escribir en sus tablas. `AGENTS.md` ya lo reconoce.
- **Por qué importa aquí:** si algún día aparece un fallo (por ejemplo una inyección SQL, que hoy no encontré), el daño sería total. Además, las tablas "solo de inserción" (`auditoria_autorizaciones`, `actividad_superadmin`) se protegen con disparadores que un superusuario puede desactivar; con un usuario limitado esa protección sí sería firme (Ley 1581: la prueba de las autorizaciones no debe poder alterarse).
- **Dónde:** variables `DB_USER`/`DB_PASSWORD` del `.env` (no lo leí; ver "límites") y `src/db/pool.ts`.
- **Cómo se arregla:** crear dos roles: uno **de la aplicación** (solo `SELECT/INSERT/UPDATE/DELETE` en sus tablas, sin `CREATEDB`, sin superusuario, sin permiso de desactivar disparadores ni de modificar `auditoria_autorizaciones`/`actividad_superadmin` salvo insertar) y otro **de migraciones** (dueño de las tablas) que solo se use en `npm run db:migrate`. Probarlo en desarrollo antes de producción.

## MEDIO

### M-1. Límites de intentos solo por IP, compartidos entre pantallas y en memoria (incluye el pendiente "contador compartido")
- **Estado: RESUELTO en la tanda 3 (2026-10-26). Cada ruta de login tiene su propio límite por IP y hay un contador por cuenta guardado en la base de datos (tabla `intentos_login`). Queda pendiente solo el almacenamiento compartido de los límites por IP (Redis) para cuando haya más de una instancia.**
- **Qué es:** el contador de intentos fallidos de login es **uno solo** y se comparte entre el login único (`acceso.ts:60`), el login del personal (`auth.rutas.ts:21`), el de cuentas (`cuentas.rutas.ts:121`), eliminar la cuenta (`cuentas.rutas.ts:137`) y el login del superadmin (`superadmin.rutas.ts:150`): todos usan el mismo `limitadores.login` (`limitadores.ts:59-64`), con 10 fallos por IP cada 15 minutos.
- **Problemas:**
  1. **Falsos bloqueos:** en redes móviles (donde muchas personas comparten una IP pública) o en un local con una sola conexión, 10 fallos de cualquiera bloquean el login de todos por 15 minutos, incluido el personal de otro negocio.
  2. **No frena a un atacante con muchas IP:** no hay contador por cuenta (solo el superadmin tiene bloqueo por cuenta). Las contraseñas viejas ya existentes siguen valiendo aunque sean débiles (las reglas de complejidad solo aplican a las nuevas).
  3. **Está en memoria** (`limitadores.ts:10-12`, lo dice el propio comentario): al reiniciar el servidor, o con más de una instancia, el conteo se pierde o se parte.
- **Cómo se arregla:** (a) un contador por cuenta (usuario/correo) guardado en la base, con espera creciente, además del de IP; (b) separar el límite del superadmin y el de eliminar cuenta del de login normal; (c) subir el límite por IP para IP compartidas; (d) un almacenamiento compartido (Redis o tabla) cuando haya más de una instancia.

### M-2. `TRUST_PROXY` y lectura de la IP: depende de cómo se despliegue
- **Estado: RESUELTO EN EL CÓDIGO en la tanda 3 (2026-10-26). El valor por defecto es seguro (`0`), `CF-Connecting-IP` solo se acepta con `DETRAS_DE_CLOUDFLARE=true` y la guía por hosting está en `docs/despliegue/trust-proxy.md`. **Pendiente al publicar:** decidir y comprobar el valor final.**
- **Qué es:** por defecto `TRUST_PROXY=0` (`entorno.ts:31`). Si el servidor queda detrás de un proxy o balanceador (casi seguro en producción) y no se configura, **todos los usuarios parecen tener la misma IP**: los límites se vuelven globales (10 fallos de cualquiera bloquean a todos) y la IP guardada como prueba legal es la del proxy. Si se configura con un número mayor al real, un atacante puede **inventar** su IP con `X-Forwarded-For` y saltarse los límites.
- **Además:** cuando `TRUST_PROXY > 0`, el código confía en el encabezado `CF-Connecting-IP` aunque no se use Cloudflare (`src/modules/legal/legal.ts:51-57`). Detrás de otro proxy, cualquiera podría escribir ese encabezado y **falsear la IP de la prueba de autorización**.
- **No pude confirmar** cómo se desplegará (no hay configuración de producción en el repositorio): queda por validar.
- **Cómo se arregla:** documentar el valor exacto de `TRUST_PROXY` para el hosting elegido; aceptar `CF-Connecting-IP` solo si existe una variable explícita que diga "detrás de Cloudflare"; y un test que cubra ambos casos (hoy `TRUST_PROXY` no tiene pruebas).

### M-3. Contraseñas heredadas en texto plano se siguen aceptando
- **Estado: RESUELTO en la tanda 2 (2026-10-26).** En la base de desarrollo había 0 cuentas con contraseña sin cifrar y la rama de texto plano ya no existe; ver "SEGUIMIENTO – TANDA 2" al final. Lo que sigue describe el problema original.
- **Qué es:** si el valor guardado no parece un hash bcrypt, el login lo compara como texto plano y luego lo convierte (`src/modules/auth/contrasenas.ts:35-37`). Era una migración de datos viejos. Si en la base quedan integrantes del personal que nunca volvieron a entrar, **su contraseña está en claro** y cualquier lectura de la base (copia de seguridad, error, empleado con acceso) la expone. El script `db:cifrar-contrasenas` existe pero es manual (`src/db/cifrarContrasenas.ts`).
- **Cómo se comprueba (solo lectura):** `SELECT count(*) FROM barberos WHERE password_hash !~ '^\$2[aby]\$';`
- **Cómo se arregla:** ejecutar `db:cifrar-contrasenas` en cada base real; después quitar la rama de texto plano de `verificarContrasena` (o una migración que obligue a restablecer). Las pruebas de siembra usan textos como `'1234'` (`test/apoyo/baseDePrueba.ts:28`) y habría que cambiarlas a hashes.

### M-4. Sesiones: duran 12 horas, no se pueden cerrar y las del personal no se invalidan al cambiar la clave
- **Estado: RESUELTO en la tanda 3 (2026-10-26). `version_sesion` también para el personal, `POST /api/v1/logout` y cierre de las demás sesiones al cambiar la contraseña. **Pendiente para cuando se publique:** refresh tokens.**
- **Qué es:**
  - Los tokens del **personal** (`tokens.ts:38-39`) no llevan número de versión: si la administradora cambia la contraseña de un integrante (o este la cambia), el token anterior **sigue sirviendo hasta 12 horas** (`JWT_EXPIRA_EN`, `entorno.ts:20-23`). Un integrante eliminado sí pierde la sesión (se lee `activo` en cada solicitud, `auth.servicio.ts:77-81`).
  - **No existe "cerrar sesión" en el servidor** para personal ni cuentas (solo el superadmin lo tiene, `superadmin.rutas.ts:161`): al cerrar sesión en la app solo se borra el token del celular; si alguien lo copió, sigue valiendo.
  - Las cuentas (administradora y cliente) sí se invalidan al cambiar la contraseña (`version_sesion`), lo cual está bien.
- **¿Refresh tokens?** Conviene **cuando la app esté en producción**, no antes: un token de acceso corto (15-60 min) más un token de renovación que se guarda en la base (como hash), rota en cada uso y se puede revocar con "cerrar sesión" y "cerrar todas mis sesiones". Costo: más piezas y más tablas. Mientras tanto, lo mínimo útil es: poner `version_sesion` también en `barberos` y subirla al cambiar la clave, y un `POST /logout` que la suba.

### M-5. Superadmin: se puede bloquear al dueño desde fuera
- **Estado: RESUELTO en la tanda 3 (2026-10-26). El bloqueo es por cuenta + IP y el mensaje es el mismo exista o no la cuenta. Los fallos de login quedan en el registro del servidor.**
- **Qué es:** la cuenta del superadmin se bloquea 15 minutos tras 5 fallos seguidos (`superadmin.repositorio.ts:34-47`). Quien conozca su correo puede enviar 5 intentos malos cada 15 minutos y mantenerlo **fuera del panel de forma indefinida** (el límite por IP de 10 fallos lo permite). Además, el mensaje de bloqueo (`superadmin.servicio.ts:127-131`) confirma que ese correo es de una cuenta.
- **Lo que sí está bien en el superadmin:** 2FA por TOTP con códigos de un solo uso, clave del 2FA cifrada (AES-256-GCM), sesión de 1 hora, cierre a los 15 minutos de inactividad leído de la base, cierre de sesión que invalida el token, token de otro tipo que ninguna otra guardia acepta, y registro de actividad que la base no deja editar ni borrar.
- **Cómo se arregla:** no contar como "fallo de cuenta" los intentos desde IP desconocidas, o aplicar el bloqueo por pareja (cuenta + IP); responder con el mismo mensaje exista o no la cuenta; avisar por correo cuando haya bloqueos repetidos; y registrar los intentos fallidos en `actividad_superadmin`.

### M-6. Eliminar la cuenta no borra todos los datos personales (Ley 1581)
- **Estado: RESUELTO en la tanda 3 (2026-10-26). (puntos 1 a 3). Quedan por decidir con un abogado el plazo de conservación de IP y navegador de la prueba de autorizaciones (punto 4) y el aviso sobre el texto de las PQRS (punto 5).**
- **Qué es:** lo que **sí** hace bien: borra la fila de la cuenta (correo, usuario, teléfono, nombre, contraseña), anonimiza al cliente en cada negocio, anonimiza las PQRS y cierra las sesiones. Lo que **queda** (`src/modules/cuentas/eliminacion.servicio.ts:51-72`):
  1. Al **cerrar un negocio**, no se borran los datos de su equipo: nombre, usuario de inicio de sesión y **fotos** de cada integrante siguen en la base y en disco (`AGENTS.md` lo dice: "No se borran el negocio ni sus fotos"). Lo mismo con los integrantes que la administradora ya "eliminó" del equipo (solo se desactivan).
  2. Si la administradora elimina su cuenta pero el negocio sigue, `empresas.nombre_administradora` conserva su nombre, y su perfil de profesional queda desactivado **con su nombre y foto**.
  3. Las **notificaciones** guardadas para el personal llevan el nombre del cliente en el texto («Juan reservó…»); al anonimizar al cliente, ese texto no cambia (`notificaciones.servicio.ts:75-94`).
  4. La prueba de autorización guarda IP y navegador (User-Agent) sin plazo de conservación. Conservarla es razonable como evidencia, pero debe estar justificado y tener un plazo en la política.
  5. El texto de una PQRS puede traer datos personales y no se edita (también está justificado como registro, pero conviene decírselo al usuario).
- **Cómo se arregla:** al cerrar el negocio, anonimizar nombre/usuario de los integrantes y borrar sus fotos del disco; poner `nombre_administradora` en un texto neutro al eliminar a esa persona; reemplazar el nombre del cliente en las notificaciones antiguas al anonimizar; definir en la política un plazo para IP/User-Agent.

### M-7. La recuperación de contraseña no funciona en producción
- **Qué es:** con `NODE_ENV=production` no hay proveedor de correo: no se envía nada y solo queda el evento `correo_sin_proveedor` en el log (`src/shared/correo.ts:25-26`). Una administradora o cliente que olvide la contraseña **no puede recuperarla**. No es un fallo de seguridad, pero es un bloqueo para el lanzamiento.
- **Relacionado:** el límite "3 códigos por correo cada 15 minutos" se cuenta por correo, no por persona (`limitadores.ts:73-79`): cualquiera que sepa el correo de otra persona puede gastar esos 3 intentos y **impedirle pedir su código** durante 15 minutos.
- **Cómo se arregla:** conectar un proveedor (el código ya está preparado: `EnviadorCorreo`) y contar el límite por correo **y** por IP juntos.

### M-8. CORS no permite `PUT` ni `DELETE`
- **Estado: RESUELTO en la tanda 3 (2026-10-26).**
- **Qué es:** `src/shared/http/cors.ts:18` solo permite `GET`, `POST` y `PATCH`. Varias rutas usan `PUT` y `DELETE` (subir fotos, registrar o borrar el dispositivo de notificaciones, cambiar el intervalo, eliminar servicios/productos/bloqueos). En la **versión web** el navegador bloqueará esas llamadas; las apps nativas no se ven afectadas porque no usan CORS. Es un error de funcionamiento, no un agujero.
- **Cómo se arregla:** agregar `'PUT'` y `'DELETE'` (y un test que haga la solicitud de verificación previa).

## BAJO

### B-1. El mensaje que revela si un correo (o teléfono, o usuario) ya existe — pendiente anotado
- **Estado: RESUELTO en la tanda 3 (2026-10-26). Correo, usuario o teléfono repetidos responden el mismo mensaje. `GET /empresas/codigo-disponible` sigue igual a propósito (el código del negocio es público).**
- **Qué es:** al registrarse, la API responde `Ya existe una cuenta con ese correo`, `Ese usuario ya está en uso` o `Ya existe una cuenta con ese número de teléfono` (`src/modules/cuentas/cuentas.servicio.ts:44-59`). Cualquiera puede comprobar si una persona tiene cuenta. También lo permite `GET /empresas/codigo-disponible/:codigo` (esto último es deliberado para el formulario). La recuperación de contraseña y el login **sí** están bien: responden igual exista o no la cuenta.
- **Cómo se arregla:** es un equilibrio entre comodidad y privacidad. Opciones: dejarlo (limitado a 10 registros por IP cada 15 minutos) o responder genérico y confirmar por correo. Mientras se deje, el límite de registros debe seguir activo.

### B-2. El límite de registros cuenta también los intentos con errores y los exitosos — pendiente anotado
- **Estado: RESUELTO en la tanda 3 (2026-10-26). Los errores de validación (400) ya no cuentan.**
- **Qué es:** `limitadores.registro` (`limitadores.ts:67`) cuenta **todos** los intentos: una persona que se equivoca en el formulario varias veces o varias personas detrás de la misma IP pueden gastar los 10 y quedar bloqueadas 15 minutos. Pasa lo contrario con el login (que solo cuenta fallos).
- **Cómo se arregla:** no contar los 400 de validación; contar solo los registros que llegan a crear algo, o subir el tope y añadir un límite diario por IP.

### B-3. Cancelar una cita inexistente: respuestas distintas e incoherentes — pendiente anotado
- **Estado: RESUELTO en la tanda 3 (2026-10-26). Cita inexistente o de otro negocio: 404; el 409 queda solo para "ya estaba atendida o cancelada".**
- **Qué es:** `PATCH /citas/:id/cancelar` revisa la suscripción **antes** de mirar si la cita existe (`src/modules/citas/citas.rutas.ts:56-65`, `suscripcion.ts:49-55`). Con la suscripción vencida, cualquier id (existente o no) devuelve **402**; con la suscripción vigente, una cita inexistente o de otro negocio devuelve **409** *«No se pudo cancelar: la cita no existe o ya fue atendida o cancelada»* (`citas.servicio.ts:349`) en lugar de un 404. No filtra datos de otros negocios (el mensaje es el mismo), pero es confuso para la app.
- **Cómo se arregla:** decidir el orden (primero existencia → 404, luego suscripción → 402) y dejar el 409 solo para "ya estaba cancelada o atendida".

### B-4. Un solo secreto (`JWT_SECRET`) para tres usos
- **Estado: RESUELTO en la tanda 3 (2026-10-26). Tres secretos independientes (`JWT_SECRET`, `RECUPERACION_SECRET`, `TOTP_SECRET`) y el comando `db:recifrar-2fa`. Ver las notas del segundo paso en "SEGUIMIENTO – TANDA 3".**
- **Qué es:** el mismo `JWT_SECRET` firma las sesiones, calcula los códigos de recuperación y deriva la llave que cifra el 2FA del superadmin (`totp.ts:83`). Si se filtra, se pueden falsificar sesiones y descifrar el segundo paso. Rotarlo obliga a reiniciar el 2FA del superadmin.
- **Cómo se arregla:** tres variables independientes (firma de sesiones, HMAC de códigos, llave del 2FA).

### B-5. Notificaciones push
- **Estado: RESUELTO en la tanda 3 (2026-10-26). Los textos no llevan el nombre del cliente y los celulares que no se registran en 60 días se borran.**
- **Qué es:** el token de Expo se valida con formato estricto y el dueño sale de la sesión, no del cuerpo (`dispositivos.rutas.ts`): bien. Riesgos menores: (1) el **texto de la notificación lleva el nombre del cliente** y se envía a Expo (un tercero, posiblemente fuera de Colombia): debe mencionarse en la política de datos; (2) si alguien cierra sesión sin que la app llame a `DELETE /dispositivos` (cierre forzado, token caducado), el celular **sigue recibiendo avisos** de esa cuenta hasta que otra persona registre ese token.
- **Cómo se arregla:** textos sin nombre (o solo el nombre de pila) en la push, y vencer los tokens inactivos (por ejemplo tras 60 días sin uso).

### B-6. Comandos de desarrollador (`npm run dev:*`) en producción
- **Estado: RESUELTO en la tanda 3 (2026-10-26). Todos los que cambian algo quedan en la actividad del superadmin; los peligrosos se niegan en producción y `dev:activar-plan` pide confirmación. No se cambió el nombre `dev:`.**
Todos son comandos de consola (no están expuestos por HTTP), así que solo los puede usar quien tenga acceso al servidor y a su `.env`. Solo uno está bloqueado en producción.

| Comando | ¿Funciona con `NODE_ENV=production`? | Riesgo |
| --- | --- | --- |
| `dev:simular-vencimiento` | **No** (se niega, `simularVencimiento.ts:13`) | Bajo |
| `dev:activar-plan` | Sí, a propósito | Da un plan pagado sin pago real; queda en `activaciones_plan` (origen `comando`) pero **no** en el registro de actividad del superadmin |
| `dev:cargos` (`pagar`) | Sí | Marca cargos como pagados sin pago real |
| `dev:pqrs` (`responder`) | Sí | Cambia estados y respuestas de PQRS sin registro de actividad |
| `dev:crear-superadmin` | Sí, es la única forma de crearlo | Crea una cuenta con poder total |
| `dev:restablecer-superadmin` | Sí | Cambia contraseña y 2FA del superadmin; **no deja rastro** en `actividad_superadmin` |
| `dev:eliminar-superadmin` | Sí | Pide confirmación; nunca borra al último |
| `db:cifrar-contrasenas` | Sí | Reescribe contraseñas (hay que hacer copia antes) |

- **Cómo se arregla:** que los comandos que cambian dinero o accesos escriban en el registro de actividad (con un "usuario" de sistema), que el nombre `dev:` no engañe (por ejemplo prefijo `admin:`), y que en producción se ejecuten solo desde un entorno controlado. Guardar el código QR del superadmin (`secretos-superadmin/`, ya ignorado por git) solo en una carpeta cifrada y borrarlo después de configurar la app.

### B-7. Registros (logs)
- **Estado: RESUELTO en la tanda 3 (2026-10-26). Los mensajes de la base se limpian antes de registrarse y los inicios de sesión fallidos quedan registrados (sin contraseñas ni usuarios).**
- **Qué es:** el registro es JSON estructurado y **no guarda contraseñas, tokens, correos ni teléfonos**; el comentario de `registro.ts` lo exige y se cumple (solo ids internos, mensajes de error y rutas). Detalles: (1) `error_no_controlado` guarda el mensaje y la pila del error (`manejadorErrores.ts:36-41`); el mensaje de algunos errores de PostgreSQL (por ejemplo un texto con formato de fecha inválido) puede incluir el valor que envió el usuario; (2) en desarrollo el correo con el código de recuperación se imprime en consola (`correo.ts:13`; no ocurre en producción); (3) no se registran los intentos de login fallidos, así que no habría forma de detectar un ataque a tiempo.
- **Cómo se arregla:** recortar o limpiar el mensaje de errores de la base, y registrar (sin la contraseña) los fallos de login con IP y momento.

### B-8. Fotos (subida y entrega): bien hechas, con dos detalles
- **Bien:** el tipo se decide por el contenido (no por el nombre), máximo 5 MB, un solo archivo, la imagen se vuelve a codificar a WebP (se descartan EXIF y GPS), tope de píxeles contra imágenes "bomba", nombre aleatorio con `flag: 'wx'`, la ruta guardada se valida con una expresión estricta y `express.static` no permite salir de la carpeta (`dotfiles: 'deny'`, sin listado). **No hay forma de leer otros archivos del servidor** con este mecanismo.
- **Detalles:** (1) las fotos son públicas por diseño (quien tenga el enlace la ve; el enlace es un UUID, no adivinable); (2) si `URL_PUBLICA` no está configurada, el enlace de la foto se arma con el encabezado `Host` de cada solicitud (`fotos.ts:139-140`): hay que configurarla en producción para que nadie pueda hacer que la API devuelva enlaces a otro dominio.

### B-9. Dependencias (`npm audit`)
- **Estado: RESUELTO en la tanda 3 (2026-10-26). `uuid` fijado en 11.1.1 con `overrides` (sin `audit fix --force`); la exportación a Excel y PDF tiene prueba. **Aparecieron dos avisos nuevos de gravedad alta** (`body-parser` y `multer`) que se corrigen con `npm audit fix` sin cambios mayores: ver "SEGUIMIENTO – TANDA 3".**
- **Resultado:** 2 avisos de gravedad **moderada**, ambos del mismo origen: `exceljs` usa `uuid` con un fallo de comprobación de límites del buffer (GHSA-w5hq-g745-h8pq) que solo aplica a `uuid` v3/v5/v6 usado con un buffer propio. No encontré que el código lo use así (los reportes solo exportan). Riesgo práctico bajo.
- **Cuidado:** `npm audit fix --force` **bajaría `exceljs` a la versión 3.4.0**, que es peor. No lo ejecutes. Lo correcto es esperar una versión de `exceljs` que actualice `uuid`, o fijar `uuid` ≥ 11.1.1 con `overrides` en `package.json` y probar la exportación a Excel.

### B-10. Defensa en profundidad en consultas (aislamiento entre negocios)
- **Estado: RESUELTO en la tanda 3 (2026-10-26). Los tres UPDATE llevan `AND empresa_id`.**
- **Conclusión del aislamiento:** **no encontré ningún endpoint por el que un negocio vea o modifique datos de otro.** El negocio sale siempre de la sesión; las consultas del personal filtran por `empresa_id`; las de los clientes con cuenta filtran por `usuario_id`; las llaves foráneas compuestas de la base impiden mezclar negocios aunque el código fallara. El rol de administrador se lee de la base en cada solicitud, así que un cambio de rol aplica de inmediato.
- **Detalle menor:** tres consultas actualizan solo por `id` después de haber comprobado la propiedad en la misma transacción (`citas.repositorio.ts:180` mover cita, `:189` avanzar última cita, `equipo.repositorio.ts:169`). Son seguras hoy, pero el filtro por negocio no está en la propia sentencia; si alguien reutiliza esas funciones sin la comprobación previa, la protección se pierde. Conviene agregar `AND empresa_id = $n`.
- **Importante:** esta conclusión hoy **no la respalda ninguna prueba que funcione** (ver A-1).

### B-11. Otros detalles menores
- **Estado: RESUELTO EN PARTE en la tanda 3 (2026-10-26): `/api/saludo` eliminado (nadie lo usaba) y el contenido de `.env.example` está listo en `docs/despliegue/env-ejemplo.txt` (falta copiarlo, ver abajo). Siguen pendientes HTTPS, integración continua y los topes por negocio de PQRS y clientes de invitado.**
- `GET /api/saludo` es público y devuelve la hora de la base y un mensaje distinto si la base cae. Útil para monitoreo; si no se necesita desde fuera, limitar a la red interna.
- El `.gitignore` menciona `.env.example`, pero ese archivo **no existe**: faltaría para documentar las variables necesarias (sin valores).
- HTTPS y redirección: el servidor usa `helmet` (incluye HSTS) pero no fuerza HTTPS; eso debe resolverlo el hosting/proxy.
- La limitación de solicitudes es **por proceso** (ver M-1).
- Conviene un tope por negocio de filas por PQRS/clientes de invitado (crecimiento sin límite).

---

# B. PENDIENTES YA ANOTADOS (estado)

| Pendiente | Confirmado | Dónde | Hallazgo |
| --- | --- | --- | --- |
| Mensaje que revela si un correo ya está registrado | Sí (también usuario y teléfono) | `cuentas.servicio.ts:44-59` | B-1 |
| Contador de login compartido entre personal y cuentas | Sí (y también superadmin y eliminar cuenta) | `limitadores.ts:59-64`; 5 rutas | M-1 |
| Límite de registros cuenta intentos con errores | Sí (cuenta todos) | `limitadores.ts:67` | B-2 |
| 402 al cancelar una cita inexistente | Sí (la suscripción se revisa antes que la cita; si hay suscripción, da 409 y no 404) | `citas.rutas.ts:56-65` | B-3 |

# C. PROTECCIÓN DE DATOS (Ley 1581 de 2012)

- **¿Se pueden alterar las autorizaciones?** Hay una tabla de solo inserción con disparadores que rechazan `UPDATE`, `DELETE` y `TRUNCATE` (migración 023) y sin llaves foráneas con borrado en cascada (la prueba sobrevive al borrado de la cuenta). ~~Mientras la app se conectaba como `postgres` (A-3), un superusuario podía desactivar el disparador.~~ Resuelto en la tanda 2: la app usa un rol que no puede desactivarlo ni cambiar esas tablas (comprobado). La IP que se guarda como prueba depende de `TRUST_PROXY` (M-2).
- **¿Eliminar la cuenta borra o anonimiza de verdad?** En gran parte sí (cuenta, cliente, PQRS, sesiones, tokens push); quedan los datos del equipo y fotos al cerrar un negocio, el nombre de la administradora y el nombre del cliente en notificaciones antiguas (M-6).
- **¿Se guardan datos innecesarios?** En general no: el equipo no tiene teléfono, el negocio ya no guarda NIT ni correo. Para revisar: IP y User-Agent de la prueba sin plazo, nombre del cliente dentro de las notificaciones y en el contenido de las push (B-5), y textos legales aún **en borrador** con espacios por llenar (`[NOMBRE DEL RESPONSABLE]`, `[CORREO DE CONTACTO]`…) que deben revisarse con un abogado antes de publicar la app.

# D. CALIDAD DEL CÓDIGO

- **Bien:** capas claras (rutas → servicio → repositorio), TypeScript sin `any` y sin errores de tipos, errores siempre como `{ "error": "mensaje" }` sin detalles internos, validación con zod en la entrada, SQL parametrizado (los pocos textos interpolados en el SQL son constantes internas, no datos del usuario), 13 módulos usan transacciones y las reservas bloquean la fila del profesional (`FOR UPDATE`) más una restricción de la base como última defensa.
- **Mejorable:**
  - Dos copias de la lógica de "convertir token en sesión" (`auth.servicio.ts` y `cuentas.servicio.ts`) y varias listas repetidas de guardias; un cambio de seguridad hay que hacerlo en dos sitios.
  - `contextoDe` (lectura de la IP) vive en `legal.ts` pero lo usan reservas y cuentas: debería estar en `shared/http/`.
  - Archivos grandes: `superadmin.servicio.ts` (527 líneas) y `superadmin.repositorio.ts` (509); aceptables, pero conviene dividirlos por tema (negocios, PQRS, ingresos, actividad).
  - No hay integración continua ni `.env.example`.
  - El repositorio contiene unos 60 archivos que no son del backend (`postgres/`, `.agents/`, `.claude/skills/`, `skills-lock.json`): no son un riesgo, pero ensucian las revisiones.

# E. PRUEBAS

- **Resultado de la corrida:** 96 pruebas, 36 pasan, 30 fallan, 30 se cancelan (A-1). Tiempo: unos 56 segundos.
- **Pasan:** autenticación (10), límite de intentos de login, manejo de errores, CORS en producción y conversión de horas.
- **Fallan por pruebas viejas:** administración de empresa y suscripción, registro de empresa, cuentas de cliente, permisos y aislamiento entre negocios, migración 003, reservas simultáneas, validación de reservas.
- **Partes críticas sin ninguna prueba** (busqué por nombre en `test/`):
  - **Permisos entre negocios:** existen pero **no corren** (A-1). No hay pruebas de aislamiento para clientes, bloqueos, productos, servicios, cartera, reportes ni notificaciones.
  - **Horas disponibles** (`disponibilidad.ts`, `calcularHoras`): solo hay pruebas de conversión de horas, ninguna del cálculo de huecos.
  - **Reservas simultáneas:** existe, pero **no corre** (A-1).
  - **Cobros proporcionales y niveles** (`cobro.ts`/`reajustarCobro`, cargos, niveles Emprendedor/Equipo/Pro): sin pruebas.
  - **Zona horaria:** sin pruebas (días de prueba, "hoy", límite de 14 días, recordatorios). Además `fechaEnDias` de `test/apoyo/baseDePrueba.ts:12` usa la fecha del computador, no la del negocio, y puede fallar cerca de medianoche.
  - **Planes y funciones** (`funcion_no_incluida`), **reportes y exportación**, **superadmin** (2FA, inactividad, bloqueo), **eliminación de cuenta**, **recuperación de contraseña**, **reprogramación y cancelación del cliente**, **fotos**, **TRUST_PROXY**: sin pruebas propias.
- **Recomendación sobre la base de pruebas:** hoy las pruebas usan el mismo usuario del `.env` de desarrollo, que necesita `CREATEDB` (en la práctica, `postgres`). Es seguro porque cada una crea y borra su propia base, pero conviene: (1) un rol de PostgreSQL solo para pruebas con `CREATEDB` y sin superusuario, (2) un archivo `.env.test` (ignorado por git) con sus credenciales, y (3) revisar de vez en cuando si quedaron bases sobrantes tras una caída: `SELECT datname FROM pg_database WHERE datname LIKE 'agendamiento_prueba_%';`.

---

# TABLA RESUMEN

| # | Gravedad | Hallazgo | Dónde | Arreglo en una línea |
| --- | --- | --- | --- | --- |
| A-1 | **Alto** (resuelto, tanda 1) | 60 de 96 pruebas no corren; las de permisos, aislamiento y reservas simultáneas están entre ellas | `test/apoyo/servidor.ts:152`, `test/adminEmpresa.test.ts:29` | Actualizar los ayudantes de prueba y correr `npm test` en cada cambio |
| A-2 | **Alto** (resuelto, tanda 3) | Reservas falsas de invitados sin verificar el teléfono | `citas.rutas.ts:23`, `citas.servicio.ts:38` | Tope de citas pendientes por teléfono/negocio y confirmación del teléfono |
| A-3 | **Alto** (resuelto, tanda 2) | La app usa el superusuario `postgres` | `.env` / `pool.ts` | Rol de aplicación limitado y rol aparte para migraciones |
| M-1 | Medio (resuelto, tanda 3) | Límite de login solo por IP, compartido en 5 rutas y en memoria | `limitadores.ts:59-64` | Contador por cuenta en base y límites separados |
| M-2 | Medio (resuelto en código, tanda 3; valor final al publicar) | `TRUST_PROXY` y lectura de IP (puede falsear límites y la IP legal) | `entorno.ts:31`, `legal.ts:51-57` | Fijar el valor según el hosting y confiar en `CF-Connecting-IP` solo si se declara |
| M-3 | Medio (resuelto, tanda 2) | Contraseñas heredadas en texto plano aún aceptadas | `contrasenas.ts:35-37` | Ejecutar `db:cifrar-contrasenas` y quitar esa rama |
| M-4 | Medio (resuelto, tanda 3; refresh tokens al publicar) | Sesiones de 12 h sin cierre en servidor; las del personal no se invalidan al cambiar la clave | `tokens.ts:38-39` | `version_sesion` en `barberos` y `POST /logout`; refresh tokens al ir a producción |
| M-5 | Medio (resuelto, tanda 3) | Se puede bloquear al superadmin desde fuera | `superadmin.repositorio.ts:34-47` | Bloqueo por cuenta+IP y mensaje genérico |
| M-6 | Medio (resuelto, tanda 3) | Eliminar cuenta deja datos del equipo, fotos y nombres | `eliminacion.servicio.ts:51-72` | Anonimizar equipo, borrar fotos y limpiar notificaciones |
| M-7 | Medio | Recuperar contraseña no funciona en producción (sin correo) | `correo.ts:25-26` | Conectar un proveedor de correo |
| M-8 | Medio (resuelto, tanda 3) | CORS no permite PUT ni DELETE (web) | `cors.ts:18` | Agregar `PUT` y `DELETE` |
| B-1 | Bajo (resuelto, tanda 3) | Mensaje que revela si correo/usuario/teléfono ya existen | `cuentas.servicio.ts:44-59` | Mensaje genérico o confirmación por correo |
| B-2 | Bajo (resuelto, tanda 3) | Límite de registros cuenta intentos con errores | `limitadores.ts:67` | No contar los 400 de validación |
| B-3 | Bajo (resuelto, tanda 3) | Cancelar cita inexistente: 402/409 en vez de 404 | `citas.rutas.ts:56-65` | Revisar existencia antes que suscripción |
| B-4 | Bajo (resuelto, tanda 3) | Un solo secreto para sesiones, códigos y 2FA | `totp.ts:83` | Tres secretos independientes |
| B-5 | Bajo (resuelto, tanda 3) | Push con nombre del cliente y tokens que no vencen | `notificaciones.servicio.ts:75-94` | Textos sin nombre y vencimiento de tokens |
| B-6 | Bajo (resuelto, tanda 3) | Solo 1 de 8 comandos `dev:*` se bloquea en producción; varios sin registro | `src/db/*.ts` | Registrar en actividad y renombrar |
| B-7 | Bajo (resuelto, tanda 3) | Logs: sin datos sensibles, pero sin registro de logins fallidos y mensajes de BD sin limpiar | `manejadorErrores.ts:36-41` | Limpiar mensajes y registrar fallos de login |
| B-8 | Bajo | Fotos bien protegidas; falta fijar `URL_PUBLICA` | `fotos.ts:139-140` | Configurar `URL_PUBLICA` en producción |
| B-9 | Bajo (resuelto, tanda 3; 2 avisos altos nuevos) | `npm audit`: 2 avisos moderados (`exceljs` → `uuid`) | `package.json` | `overrides` de `uuid`; **no** usar `audit fix --force` |
| B-10 | Bajo (resuelto, tanda 3) | Tres UPDATE por `id` sin filtro de negocio en la propia sentencia | `citas.repositorio.ts:180,189`, `equipo.repositorio.ts:169` | Agregar `AND empresa_id` |
| B-11 | Bajo (parcial, tanda 3) | `/api/saludo` público, falta `.env.example`, sin HTTPS forzado, sin CI | varios | Limpiezas menores |

**Totales:** 0 Críticos · 3 Altos · 8 Medios · 11 Bajos.

**Estado tras la tanda 3:** resueltos A-1, A-2, A-3, M-1, M-2 (en el código), M-3, M-4, M-5, M-6, M-8, B-1, B-2, B-3, B-4, B-5, B-6, B-7, B-9, B-10 y B-11 (en parte). **Quedan para cuando se publique:** M-7 (correo real), B-8 (`URL_PUBLICA`), HTTPS, integración continua y el valor final de `TRUST_PROXY`.

## Orden sugerido para arreglar

1. A-1 (pruebas) primero: sin ellas, el resto de arreglos no se puede comprobar.
2. A-3 y M-3 (base de datos y contraseñas) antes de tener datos reales.
3. A-2, M-1, M-2 y M-4 antes de publicar la app.
4. M-6 y M-7 antes de usar la política de datos con usuarios reales.
5. El resto, en el orden de la tabla.

---

# SEGUIMIENTO – TANDA 1 (hallazgo A-1: pruebas)

**Fecha:** 2026-10-25 · **Rama:** `auditoria` · **Resultado:** `npm test` → **211 pruebas, 211 pasan, 0 fallan, 0 canceladas** (antes: 96, 36 pasaban) · `npm run typecheck` sin errores · en PostgreSQL no quedaron bases temporales.

## Qué se hizo

1. **Base de pruebas separada.** Las pruebas ya no leen `DB_NAME`. Usan `TEST_DB_NAME` (en este equipo, `agendamiento_test`) y se **niegan a correr** si falta, si es `agendamiento_db` o igual a `DB_NAME`, o si el nombre no contiene "test" o "prueba" (`test/apoyo/configuracionPruebas.ts`, probado en `test/guardiaBaseDePrueba.test.ts`). Cada archivo crea una base temporal `<TEST_DB_NAME>_<proceso>_<hora>` y solo puede borrar bases con ese prefijo. Instrucciones en `AGENTS.md`.
2. **Ayudantes actualizados** (`test/apoyo/`): registro de empresa con el contrato actual (código del negocio, ubicación oficial, horario por día, usuario, aceptaciones), contraseñas que cumplen la regla, teléfonos válidos en E.164, reservas con aceptación de política y términos, fechas calculadas en la zona del negocio (no la del computador) y un superadmin de prueba con su segundo paso real.
3. **Pruebas viejas actualizadas por reglas que cambiaron a propósito, sin quitarles fuerza** (cada una comprueba lo mismo o más): días de prueba contados como días de calendario en la zona del negocio; Mi negocio y la suscripción siguen disponibles con la suscripción vencida y la gestión y la agenda no; el NIT y los días de atención ya no existen (la prueba de la migración 003 corre ahora contra el esquema de la 003); los teléfonos se normalizan a E.164; las reservas llegan hasta hoy + 14 días; la cuenta de la administradora sí entra a los endpoints del personal de su negocio; la contraseña nueva exige mayúscula, minúscula, número y carácter especial.
4. **Pruebas nuevas** (211 en total, 115 más que las 96 originales):

| Archivo | Qué vigila |
| --- | --- |
| `aislamientoNegocios.test.ts` | El negocio A intenta leer y cambiar, por id, equipo, servicios, productos, clientes, lista negra, bloqueos, cartera, horas, reservas y notificaciones del negocio B; y un cliente con cuenta intenta tocar la cita de otro cliente. Todo responde 404 y los datos de B no cambian. |
| `rolesPermisos.test.ts` | Matriz de 25 endpoints × 6 roles (anónimo, cliente, empleado, administrador del personal, cuenta de la administradora, superadmin), token falso, un empleado que intenta darse permisos y un administrador que intenta quitarse el rol. |
| `disponibilidad.test.ts` | Cálculo de horas (ejemplo documentado, almuerzo de 12 a 13 con servicios de 30, 60 y 90 minutos, intervalos, horas pasadas) y por la API: el almuerzo semanal bloquea reservas, no afecta a otro profesional y no deja bloquear una hora con cita. |
| `reservas.test.ts` (ampliado) | Dos reservas simultáneas a la misma hora (5 rondas) y una reserva contra un bloqueo a la vez (4 rondas): siempre se guarda una sola cosa. |
| `cobro.test.ts` | Precios, niveles 1 / 2 a 5 / 6 a 10, tope de 10, funciones por nivel (403 con el nivel que la incluye), cargos proporcionales (mensual, anual, mínimo de $10.000, reemplazos sin costo, administradores que no atienden, "Yo también atiendo"), activación desde el panel y días de prueba sumados. |
| `zonaHoraria.test.ts` | Funciones de zona con instantes fijos (incluido horario de verano) y un negocio en Nueva Zelanda frente a uno en Bogotá: "hoy", límite de 14 días, días de prueba, desfase en las respuestas, cambio de zona y anticipación de cancelación en la hora del negocio. |
| `autorizaciones.test.ts` | La auditoría y el registro de actividad del superadmin no se pueden modificar ni borrar; prueba de cada aceptación; versión nueva de la política; IP y navegador solo de la petición; lectura de la IP con `TRUST_PROXY` 0 y 1; el límite de login no se evita inventando `X-Forwarded-For`; eliminar la cuenta (cliente, única administradora, administradora con otro administrador). |

## Errores reales del código encontrados al escribir las pruebas

**Ninguna prueba falló por un error real del código**: todos los fallos fueron de las pruebas (datos viejos) o reglas que cambiaron a propósito. Observaciones menores para la siguiente tanda (no se corrigió nada):

| # | Gravedad | Observación | Dónde |
| --- | --- | --- | --- |
| T1-1 | Bajo | `GET /cartera?barberoId=<id de otro negocio>` responde 200 con ceros y repite ese id en `barberoId`. No filtra datos de B, pero lo correcto sería 404 "Profesional no encontrado", como el resto de los endpoints. | `src/modules/cartera/` |
| T1-2 | Bajo | `AGENTS.md` se contradice: en "Eliminar la cuenta" dice que se borra "la prueba de autorizaciones de la cuenta", pero la auditoría es de solo inserción y se conserva a propósito (la prueba nueva lo fija). Corregir el texto. | `AGENTS.md` |
| T1-3 | Informativo | La prueba "con un proxy de confianza (TRUST_PROXY=1)" fija el comportamiento actual de `CF-Connecting-IP` (se acepta de cualquiera si hay proxy). Es el hallazgo **M-2**: al corregirlo hay que actualizar esa prueba. | `test/autorizaciones.test.ts` |
| T1-4 | Informativo (solo pruebas) | Las filas sembradas antes de la migración 024 (`created_at` sin zona) quedan 5 horas en el futuro en la base de pruebas, porque la migración las interpreta como hora de Bogotá y la base de pruebas siembra en UTC. En producción no pasa (el servidor trabajaba en Bogotá). No afecta a las pruebas actuales. | `test/apoyo/baseDePrueba.ts` |

## Lo que sigue sin pruebas (para tandas siguientes)

Superadmin (2FA, bloqueo por intentos, cierre por inactividad, acciones sobre negocios), recuperación de contraseña, PQRS (plazos y prioridades), reportes avanzados y exportación a Excel/PDF, subida de fotos, recordatorios y avisos push, límites de registro y de PQRS, y cartera/resumen con comparaciones. Los hallazgos M-1 a M-8 y B-1 a B-11 siguen abiertos: ninguno se corrigió en esta tanda.

---

# SEGUIMIENTO – TANDA 2 (hallazgos A-3 y M-3: base de datos y contraseñas)

**Fecha:** 2026-10-26 · **Rama:** `auditoria` · **Resultado:** `npm test` → **221 pruebas, 221 pasan, 0 fallan, 0 saltadas** (antes: 211) · `npm run typecheck` sin errores.

## A-3. La app ya no usa el superusuario

1. **Script** `db/mantenimiento/crear-rol-aplicacion.sql` (idempotente; la contraseña se escribe a mano y no se sube a git). Crea `agendamiento_app` sin superusuario, sin `CREATEDB`, sin `CREATEROLE`. Permisos: `SELECT/INSERT/UPDATE/DELETE` en las tablas, uso de las secuencias, sin crear objetos en el esquema `public`, y permisos por defecto para las tablas que cree el usuario de migraciones. `auditoria_autorizaciones` y `actividad_superadmin`: solo `SELECT` e `INSERT`. `schema_migrations`: sin acceso.
2. **Dos usuarios en el `.env`:** `DB_USER`/`DB_PASSWORD` = rol limitado de la app; `DB_MIGRACION_USER`/`DB_MIGRACION_PASSWORD` = usuario con más permisos, usado solo por `npm run db:migrate` y por las pruebas (necesitan `CREATEDB`). Sin las variables nuevas todo funciona como antes (`cargarEntornoMigraciones`, `src/config/entorno.ts`).
3. **Comprobado en `agendamiento_db` con el rol nuevo:** la app responde (`/api/saludo`, `/categorias`, `/planes` → 200); el rol puede leer y escribir en las tablas; `DROP TABLE`, `TRUNCATE`, `ALTER TABLE`, `CREATE TABLE`, `DISABLE TRIGGER` y `DROP TRIGGER` dan "permiso denegado" (42501); en `auditoria_autorizaciones` y `actividad_superadmin` `UPDATE`, `DELETE` y `TRUNCATE` también (solo se puede leer e insertar).
4. **Prueba nueva** `test/rolAplicacion.test.ts`: aplica el script en una base temporal con otro nombre de rol (el rol real no se toca) y vigila lo anterior, además de que una tabla creada después tenga permisos y de que el script se detenga si la contraseña está en blanco.
5. **Pendiente de producción:** repetir el script en cada base real y guardar las contraseñas en el gestor de secretos del hosting. Una tabla nueva que deba ser "solo inserción" necesita su propio `REVOKE UPDATE, DELETE` en su migración (anotado en `AGENTS.md`).
6. **Incidente durante la puesta en marcha:** el script se ejecutó primero sobre `agendamiento_test` en vez de `agendamiento_db`; la app daba 500 en los endpoints con tablas (permiso denegado) hasta repetirlo sobre la base correcta. Lección: comprobar el nombre de la base en la pestaña de la Query Tool.

## M-3. Contraseñas en texto plano

1. **Cuántas había:** 0. En `barberos`, `usuarios` y `superadmins` todas las contraseñas guardadas son hashes bcrypt (el único `NULL` es un perfil de equipo inactivo, sin usuario y sin cuenta vinculada, de un negocio de pruebas: no puede iniciar sesión). `npm run db:cifrar-contrasenas` respondió `0 contraseña(s) cifrada(s)`.
2. **Código:** `verificarContrasena` (`src/modules/auth/contrasenas.ts`) ya no compara texto plano: un valor que no sea un hash bcrypt nunca es válido (y hace igual el trabajo de bcrypt para no cambiar el tiempo de respuesta). Se sigue subiendo el costo de los hashes bcrypt más débiles al iniciar sesión.
3. **Comando ampliado:** `db:cifrar-contrasenas` ahora cubre `barberos`, `usuarios` y `superadmins` (antes solo `barberos`, aunque el login de las tres tablas aceptaba texto plano).
4. **Pruebas:** las semillas (`test/apoyo/baseDePrueba.ts`) usan hashes bcrypt. Prueba nueva en `test/auth.test.ts`: con una contraseña guardada en texto plano (personal y cuenta de administradora), los tres logins (`/auth/login`, `/login`, `/cuentas/login`) responden 401 aunque la clave sea la correcta, y el valor guardado no se modifica.

## Seguimiento de la revisión de la tanda 2 (2026-10-26)

La revisión (lentes de riesgo y fiabilidad) aprobó los commits de A-3 y M-3. Se atendieron estas observaciones:

1. **Contraseñas de base de datos obligatorias.** `DB_PASSWORD` ya no puede faltar ni estar vacía, y con `DB_MIGRACION_USER` la `DB_MIGRACION_PASSWORD` es obligatoria: el arranque falla nombrando la variable (nunca su valor) en vez de probar una contraseña vacía (`src/config/entorno.ts`).
2. **Pruebas sin credenciales mezcladas.** `test/apoyo/configuracionPruebas.ts` elige el primer grupo con usuario (`TEST_DB_*`, `DB_MIGRACION_*`, `DB_*`) y usa la contraseña de ese mismo grupo; si falta, avisa con un error claro.
3. **Registro de sentencias.** `SHOW log_statement` = `none` y ningún archivo del log del servidor contiene la contraseña del rol. Ojo: `log_min_error_statement` = `error` (valor por defecto) guarda el texto de las sentencias que fallan; se anotó en la cabecera del script.
4. **Cuenta sin contraseña.** El único `password_hash` en `NULL` es un perfil de `barberos` inactivo, sin usuario ni cuenta vinculada, de un negocio de pruebas (`PRBPLAN1`): no puede iniciar sesión. `db:cifrar-contrasenas` ignora los `NULL` y ya no cifra una cadena vacía (eso la convertiría en un hash válido de la contraseña vacía): solo avisa.
5. **`REVOKE CREATE ON SCHEMA public FROM PUBLIC`** quedó aplicado en `agendamiento_db` (ni `PUBLIC` ni `agendamiento_app` pueden crear objetos en `public`).
6. **Contraseñas sin cifrar:** había 0 y quedan 0 (barberos, usuarios y superadmins).

---

# SEGUIMIENTO – TANDA 3 (hallazgos A-2, M-1, M-2, M-4, M-5, M-6, M-8, B-1 a B-7, B-9 a B-11 y pendientes menores)

**Fecha:** 2026-10-26 · **Rama:** `auditoria` · **Resultado:** `npm test` → **325 pruebas, 325 pasan, 0 fallan** (antes: 221) · `npm run typecheck` sin errores · en PostgreSQL no quedaron bases temporales.

## Qué se hizo

| Hallazgo | Qué cambió | Dónde |
| --- | --- | --- |
| **A-2** reservas falsas | Máximo de **3 citas pendientes por teléfono y negocio** (invitados y clientes con cuenta; el número está en la configuración, `MAX_CITAS_PENDIENTES`) con el mensaje «Ya tienes 3 citas pendientes en este negocio. Cancela una o espera a que se complete para reservar otra.». Cuenta las confirmadas que aún no terminan; cancelar o completar una libera un lugar. La revisión va dentro de la transacción de la reserva con un bloqueo por negocio y teléfono, así dos reservas a la vez no la saltan. Además, **15 reservas guardadas por hora y por conexión** (los intentos con error no cuentan). Sin SMS ni WhatsApp. | `src/config/reservas.ts`, `citas.servicio.ts`, `citas.repositorio.ts`, `limitadores.ts` |
| **M-1** límites | **Un límite por ruta** (login único, personal, cuentas, eliminar cuenta y superadmin) y un **contador por cuenta en la base de datos** (`intentos_login`, migración 029): 10 fallos seguidos bloquean la cuenta 15 minutos, el doble en cada bloqueo seguido (tope 4 horas), también para identificadores que no existen (la respuesta no revela qué cuentas hay). Sobrevive a un reinicio. | `src/modules/auth/intentos.ts`, `limitadores.ts` |
| **M-2** `TRUST_PROXY` | Por defecto `0` (no se cree ningún encabezado de proxy). `CF-Connecting-IP` solo se acepta con `DETRAS_DE_CLOUDFLARE=true`. La IP se lee en un solo sitio, que también usan los límites. Guía por hosting: `docs/despliegue/trust-proxy.md`. El servidor avisa en el registro si arranca en producción con `TRUST_PROXY=0`. | `src/shared/http/ip.ts`, `legal.ts`, `entorno.ts` |
| **M-4** sesiones | `version_sesion` también para el personal, `POST /api/v1/logout` (cierra todas las sesiones de esa persona y borra sus celulares de notificaciones) y, al cambiar una contraseña con `PATCH /equipo/:id`, se cierran las sesiones de ese integrante (si la cambia él mismo recibe un `token` nuevo). Refresh tokens: para cuando se publique. | `tokens.ts`, `auth.servicio.ts`, `logout.ts`, `equipo.servicio.ts` |
| **M-5** superadmin | El bloqueo es por **cuenta + IP** y el mensaje es el mismo exista o no la cuenta: quien conozca el correo no puede dejar fuera al dueño desde otra conexión. La cuenta ya no se bloquea de forma global. | `superadmin.servicio.ts` |
| **M-6** eliminar cuenta | Al cerrar un negocio, todo el equipo (también quien ya había salido) queda anónimo (`Profesional eliminado`), sus fotos se borran del servidor y también sus celulares y notificaciones. Si el negocio sigue, el perfil de quien se va queda anónimo y `nombre_administradora` pasa a `Cuenta eliminada`. Al borrar a un cliente, su nombre desaparece de las notificaciones antiguas del personal. Citas y cartera se conservan sin datos personales. | `eliminacion.servicio.ts` |
| **M-8** CORS | Permite `PUT` y `DELETE` (con prueba de la verificación previa). | `cors.ts` |
| **B-1** mensajes | Correo, usuario o teléfono repetidos: «No pudimos crear la cuenta con esos datos. Si ya tienes una, inicia sesión o recupera tu contraseña.» | `cuentas.servicio.ts` |
| **B-2** registros | El límite de registros no cuenta los errores de validación. | `limitadores.ts` |
| **B-3** cancelar | Cita inexistente o de otro negocio: **404**, antes de revisar la suscripción. | `citas.rutas.ts` |
| **B-4** secretos | Tres secretos independientes: `JWT_SECRET` (sesiones), `RECUPERACION_SECRET` y `TOTP_SECRET`, obligatorios y distintos entre sí. `npm run db:recifrar-2fa` vuelve a cifrar el segundo paso del superadmin con la llave nueva sin que nadie configure de nuevo su app autenticadora. | `entorno.ts`, `recifrado.ts` |
| **B-5** push | Los textos no llevan el nombre del cliente; los celulares que no se registran en 60 días se borran. | `notificaciones.servicio.ts`, `.repositorio.ts`, `recordatorios.ts` |
| **B-6** comandos | Todo comando que cambia algo queda en la actividad del superadmin (`comando:dev:<nombre>`). En producción se niegan `dev:cargos pagar`, `dev:pqrs responder`, `dev:simular-vencimiento` y los tres de superadmin; `dev:activar-plan` sigue funcionando y **pide confirmación**. | `src/db/comandos.ts` y cada comando |
| **B-7** registros | Lo que va entre comillas en un mensaje de error (el valor que causó un fallo de la base) se reemplaza antes de escribirlo; de un error de PostgreSQL solo se guarda código, tabla, columna y restricción. Los inicios de sesión fallidos quedan registrados (ruta, IP y un hash corto de la cuenta; nunca contraseña ni usuario). | `registro.ts`, `manejadorErrores.ts` |
| **B-9** dependencias | `uuid` fijado en 11.1.1 con `overrides` (sin `audit fix --force`). El aviso moderado desapareció y la exportación a Excel y PDF ahora tiene prueba. | `package.json` |
| **B-10** consultas | Los tres `UPDATE` llevan `AND empresa_id` en la propia sentencia. | `citas.repositorio.ts`, `equipo.repositorio.ts` |
| **B-11** otros | `/api/saludo` eliminado (el frontend no lo usaba). El contenido de `.env.example` quedó listo en `docs/despliegue/env-ejemplo.txt`. | `app.ts`, `docs/despliegue/` |

**Observaciones de la tanda 1:** T1-1 (`GET /cartera?barberoId=` de otro negocio → **404**, también en `/cartera/resumen` y los reportes) y T1-3 (la prueba de `TRUST_PROXY` ya refleja la regla nueva) resueltas; T1-2 (`AGENTS.md` se contradecía: la prueba de autorizaciones **se conserva**) corregido; T1-4 (filas sembradas 5 horas en el futuro en la base de pruebas) resuelto sembrando con la zona de Bogotá.

**Pendientes menores de la tanda 2:** `db:cifrar-contrasenas` tiene prueba propia (cifra, no toca hashes ni `NULL`, no cifra la vacía, no pisa un cambio hecho en medio). `configuracionPruebas.ts` ya no cuenta como definido un valor con solo espacios (usuario ni contraseña), recorta el usuario y respeta la contraseña tal cual; `DB_USER`, `DB_PASSWORD` y `DB_MIGRACION_PASSWORD` aplican la misma regla.

## Pruebas nuevas (resumen)

| Archivo | Qué vigila |
| --- | --- |
| `topeCitasPendientes.test.ts` | El tope de 3 (invitado y cuenta, mismo número escrito distinto, por negocio, simultáneas con distintos profesionales, cancelar/completar liberan, citas ya pasadas no cuentan, configurable) y el límite por conexión. |
| `intentosDeLogin.test.ts` | Límites separados por ruta; contador por cuenta en la base (bloquea en todas las rutas, no revela qué cuentas existen, se reinicia, sobrevive a un reinicio, bloqueos que se duplican, limpieza, registro sin contraseña); bloqueo del superadmin por cuenta + IP. |
| `sesiones.test.ts` | `POST /logout` (personal, cuenta, cliente, otros celulares, celulares de notificaciones), tokens sin versión, cambio de contraseña propia y ajena. |
| `reglasMenores.test.ts` | Límite de registros (B-2), cancelar 404 (B-3) y los tres `UPDATE` con filtro de negocio (B-10). |
| `secretos.test.ts` | Los tres secretos (obligatorios, distintos, cada uno protege solo lo suyo) y `db:recifrar-2fa`. |
| `eliminacionEquipo.test.ts` | Equipo anónimo, fotos borradas del disco, celulares y notificaciones, negocio que sigue y nombre del cliente en notificaciones antiguas. |
| `notificacionesPush.test.ts` | Push y notificación sin nombre, celulares que vencen, tarea que los borra. |
| `comandosDeDesarrollador.test.ts` | Los scripts reales: negación en producción, confirmación de `dev:activar-plan`, registro en la actividad. |
| `registroDeErrores.test.ts` | Limpieza de mensajes de la base. |
| `cifrarContrasenas.test.ts`, `exportacion.test.ts`, `semillaDeHora.test.ts` | `db:cifrar-contrasenas`, Excel/PDF y la hora de la semilla. |
| Ampliadas | `http` (verificación previa de CORS), `autorizaciones` (`CF-Connecting-IP`), `cuentas`, `aislamientoNegocios`, `guardiaBaseDePrueba`, `rolAplicacion`. |

## Decisiones y cosas a tener en cuenta

1. **Un bloqueo por intentos fallidos también rechaza la contraseña correcta** mientras dura (si no, no frenaría nada). Quien olvidó su contraseña la recupera por correo (que en producción aún no funciona: M-7). Un atacante que conozca un correo puede bloquear esa cuenta unos minutos; es el costo de frenar el ataque desde muchas IP.
2. **Segundo paso (2FA) del superadmin de desarrollo:** al ejecutar `db:recifrar-2fa` la clave guardada no se pudo leer ni con `JWT_SECRET` ni con `TOTP_SECRET`: se había cifrado con un `JWT_SECRET` anterior que ya no estaba en el `.env`. No había copia del valor viejo, así que se reinició el segundo paso con `dev:crear-superadmin -- correo --reiniciar` (contraseña y QR nuevos, configurados por el dueño). Con la clave nueva ya cifrada con `TOTP_SECRET`, `db:recifrar-2fa` no necesita volver a usarse salvo que se cambie ese secreto.
3. **Crear el primer superadmin en producción:** `dev:crear-superadmin` ya no corre con `NODE_ENV=production`; se ejecuta desde una máquina de confianza apuntando a esa base con `NODE_ENV=development`. Es un cinturón contra errores, no un candado contra quien ya controla el servidor.
4. **`.env.example`:** el sistema bloqueó escribirlo con las reglas de permisos; el dueño lo creó a partir de `docs/despliegue/env-ejemplo.txt` y se subió (idéntico a esa plantilla, sin valores reales).
5. **Avisos nuevos de `npm audit`:** `body-parser` y `multer` (gravedad alta, denegación de servicio) se corrigieron con `npm audit fix` (sin `--force`): `body-parser` 2.4.0 y `multer` 2.5.0. `npm audit` ya reporta 0 vulnerabilidades.
6. **Revisión nativa de los commits de riesgo alto** (con el consentimiento del dueño, cada una sobre su propio corte del cambio, en copias aparte del repositorio): **las tres quedaron aprobadas.** Detalle en "Resultado de las revisiones" más abajo.
7. **Un comando que ya cambió la contraseña no pierde las credenciales:** `dev:crear-superadmin` y `dev:restablecer-superadmin` muestran primero la contraseña y el QR y después anotan en la actividad; si anotar falla, avisan en lugar de dejar a la persona sin acceso (observación de la revisión de secretos).
8. **Siguen para cuando se publique:** M-7 (correo real), B-8 (`URL_PUBLICA`), HTTPS, integración continua, refresh tokens, Redis para los límites por IP con varias instancias y el valor final de `TRUST_PROXY`.

## Resultado de las revisiones (2026-10-27)

| Commit | Qué cubre | Resultado |
| --- | --- | --- |
| `52bc3e0` | Límites por ruta, contador por cuenta en la base y bloqueo del superadmin por cuenta + IP | **Aprobada** en la segunda ronda. La primera encontró un bloqueo: en ese corte las rutas pedían el contador `intentos`, pero la conexión en `app.ts` estaba en otro commit (efecto de dividir por temas; el código final sí la tiene). Se corrigió con 57 líneas. |
| `19b2143` | `version_sesion` del personal, `POST /logout`, cierre de sesiones al cambiar la contraseña | **Aprobada** en la primera ronda. |
| `3dcfede` | Tres secretos independientes y `db:recifrar-2fa` | **Aprobada** en la primera ronda. |

Observaciones que **no bloquean** y quedan como trabajo aparte (las revisiones las listan como advertencias o sugerencias):

- **Límites y contador — corregidas (2026-10-27):**
  - Si fallaba el borrado del contador tras un inicio de sesión correcto, la persona recibía un error 500: ahora entra igual y el fallo queda en el registro (`intentos_login_fallo`).
  - Varios intentos a la vez podían saltarse el bloqueo: cada fallo se suma ahora con una sola sentencia atómica en la base (`INSERT … ON CONFLICT DO UPDATE`), y antes de dejar entrar a una contraseña correcta se vuelve a revisar el bloqueo. La limpieza de filas viejas salió del camino del fallo (`DELETE … FOR UPDATE SKIP LOCKED`), así que ya no compite por bloqueos.
  - Pruebas: `test/intentosDeLogin.test.ts` (fallo del borrado, 12 fallos simultáneos = un solo bloqueo, contraseña correcta que termina con la cuenta ya bloqueada).
- **Sesiones — corregida (2026-10-27):** al cambiar la contraseña de un integrante (también la propia) se borran los tokens de notificaciones de sus celulares (`test/sesiones.test.ts`).
- **Aceptadas (decisión del dueño, 2026-10-27):**
  - Quien conozca un correo o usuario puede bloquear esa cuenta unos minutos con intentos fallidos. Es el costo de tener bloqueo por cuenta; el bloqueo es corto, crece solo si se repite y se puede salir de él recuperando la contraseña por correo.
  - Quien pruebe contraseñas del superadmin desde muchas IP distintas sigue pudiendo intentarlo, aunque el bloqueo por cuenta + IP y el segundo paso (código de la app autenticadora) lo frenan; un límite global exigiría Redis o un servicio de borde (queda para cuando se publique).
- **Corregidas en una segunda ronda (2026-10-27):** al restablecer la contraseña con el código se quita el bloqueo y se reinician los contadores de esa cuenta (por correo, por usuario y el de eliminar la cuenta; un código equivocado no desbloquea nada); y si falla la comprobación extra del bloqueo tras una contraseña correcta, no da 500: no deja entrar, responde 429 y lo registra (`intentos_login_fallo`). Pruebas en `test/intentosDeLogin.test.ts`.
- **Siguen pendientes, de bajo riesgo (menores):** `POST /logout` responde 200 aunque la cuenta ya no exista; falta una prueba con un campo `ver` mal formado; el valor que devuelve `registrarFallo` con la cuenta ya bloqueada pasó de `0` a `max` y no tiene una aserción propia; una aserción de la prueba de intentos simultáneos podría comprobar que el bloqueo sigue activo; la limpieza de filas viejas sigue corriendo (aparte) en cada fallo y podría muestrearse o pasar a una tarea periódica; la prueba de recuperación no comprueba que otras cuentas bloqueadas antes de restablecer sigan bloqueadas, ni hay prueba de que un fallo al reiniciar los contadores al restablecer se registre sin cambiar la respuesta (la segunda revisión los aprobó como sugerencias).
- **Secretos:** la validación de `DETRAS_DE_CLOUDFLARE` sin proxy no tiene prueba propia (sí la tiene en `autorizaciones`); las pruebas dependen de módulos de otros commits (por el corte por temas).
