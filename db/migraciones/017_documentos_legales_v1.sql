-- Versión 1.0 de los documentos legales (reemplaza los borradores 0.1): Política de
-- Tratamiento de Datos, Términos y Condiciones y Aviso de privacidad (texto corto).
-- El texto fuente está en docs/legal/documentos-legales.md. Los espacios entre
-- corchetes ([NOMBRE DEL RESPONSABLE], [CORREO DE CONTACTO]…) se completan publicando
-- una versión nueva (otra migración con otra "version"); nunca edites estas filas.
-- Los clientes con cuenta deberán aceptar la versión 1.0 en su próxima reserva.

-- Un tercer tipo de documento: el aviso corto que se muestra junto a la casilla
ALTER TABLE documentos_legales DROP CONSTRAINT documentos_legales_tipo_valido;
ALTER TABLE documentos_legales
  ADD CONSTRAINT documentos_legales_tipo_valido CHECK (tipo IN ('politica_datos', 'terminos', 'aviso_privacidad'));

INSERT INTO documentos_legales (tipo, version, titulo, contenido) VALUES
(
'politica_datos',
'1.0',
'Política de Tratamiento de Datos Personales',
$doc$# Política de Tratamiento de Datos Personales

**Versión 1.0 · Vigente desde [FECHA DE ENTRADA EN VIGENCIA]**

Esta Política explica qué datos personales recoge AgendaYa, para qué los usa y cómo puedes ejercer tus derechos, en cumplimiento de la Ley 1581 de 2012 y sus decretos reglamentarios.

## 1. Responsable del tratamiento

- **Nombre:** [NOMBRE DEL RESPONSABLE]
- **Identificación:** [IDENTIFICACIÓN]
- **Domicilio:** [DOMICILIO]
- **Dirección:** [DIRECCIÓN FÍSICA]
- **Correo:** [CORREO DE CONTACTO]
- **Teléfono:** [TELÉFONO]

## 2. Alcance y papel de cada parte

AgendaYa es una plataforma que permite a negocios de servicios (barberías, peluquerías y similares) gestionar su agenda, su equipo y las reservas de sus clientes.

- **Como Responsable**, AgendaYa trata los datos de las cuentas que se crean en la plataforma: administradores de negocios, integrantes de equipo y clientes con cuenta.
- **Como Encargado**, AgendaYa trata por cuenta de cada negocio los datos de los clientes que reservan en ese negocio (su agenda, historial y lista de clientes). En ese caso, el negocio es el Responsable y decide sobre esos datos; AgendaYa los guarda y procesa siguiendo sus instrucciones y esta Política.

Esta Política aplica a los datos tratados en la app móvil, la versión web y el backend de AgendaYa.

## 3. Definiciones

Los términos Autorización, Base de Datos, Dato personal, Encargado, Responsable, Titular y Tratamiento tienen el significado del artículo 3 de la Ley 1581 de 2012.

## 4. Datos que tratamos

| Titular | Datos | Cómo los obtenemos |
| --- | --- | --- |
| Administrador del negocio | Nombre, correo, nombre de usuario, contraseña (guardada cifrada de forma irreversible) | Registro de empresa |
| Negocio | Nombre, categoría, dirección, municipio, departamento, horario, ubicación en el mapa, foto, código del negocio | Registro y "Mi negocio" |
| Integrante del equipo | Nombre, usuario, contraseña cifrada, foto, rol, porcentaje de ganancia, citas atendidas | Registro hecho por el administrador |
| Cliente con cuenta | Nombre, teléfono, correo o usuario, contraseña cifrada, negocios guardados, citas | Registro de cliente |
| Cliente invitado | Nombre, teléfono, citas | Formulario de reserva |
| Todos | Fecha, hora, versión y canal de cada autorización; registros técnicos de seguridad (dirección IP, fecha y hora de acceso, errores); identificador del dispositivo para notificaciones, si se activan | Uso de la plataforma |

AgendaYa no recoge datos sensibles (salud, origen étnico, orientación política o religiosa, vida sexual, datos biométricos). La foto de perfil o del negocio se usa solo para mostrarla dentro de la app, no para identificar a nadie por medios biométricos.

## 5. Finalidades

Los datos se usan únicamente para:

1. Crear y administrar cuentas, y permitir el inicio de sesión.
2. Gestionar reservas: agendarlas, confirmarlas, completarlas o cancelarlas.
3. Mostrar a los clientes la información pública del negocio (nombre, dirección, horario, foto, ubicación).
4. Permitir al negocio administrar su equipo, servicios, productos, bloqueos de horario y cartera.
5. Permitir al negocio restringir reservas de un teléfono (lista de bloqueados), por ejemplo por inasistencias repetidas.
6. Enviar avisos sobre las citas (recordatorios y cancelaciones), si el Titular activa las notificaciones.
7. Gestionar la prueba gratuita y los planes de suscripción del negocio.
8. Atender peticiones, quejas, reclamos y sugerencias (PQRS).
9. Proteger la seguridad de la plataforma, prevenir fraudes y cumplir obligaciones legales.
10. Generar estadísticas internas anónimas para mejorar el servicio.

AgendaYa no vende ni alquila datos personales, ni los usa para publicidad.

## 6. Niños, niñas y adolescentes

AgendaYa no está dirigida a menores de 18 años y no permite que creen cuentas. Si un menor necesita una cita, su representante legal debe hacer la reserva con sus propios datos.

## 7. Autorización

Antes de recoger datos personales, AgendaYa solicita la autorización previa, expresa e informada del Titular mediante una casilla sin marcar, en el registro de empresa, el registro de cliente y la reserva como invitado. AgendaYa guarda prueba de cada autorización: quién la otorgó, fecha y hora, canal y versión de los documentos aceptados.

Un cliente con cuenta no vuelve a autorizar en cada reserva. Solo se le pide de nuevo si se publica una versión nueva de esta Política o de los Términos.

Cuando el administrador registra a un integrante del equipo, el negocio es responsable de contar con la autorización de esa persona.

La autorización no es necesaria en los casos del artículo 10 de la Ley 1581 de 2012, como un requerimiento de autoridad competente o una orden judicial.

## 8. Derechos de los Titulares

Como Titular tienes derecho a:

1. Conocer, actualizar y rectificar tus datos.
2. Pedir prueba de la autorización que otorgaste.
3. Saber, si lo pides, qué uso se le ha dado a tus datos.
4. Presentar quejas ante la Superintendencia de Industria y Comercio (SIC), después de agotar el trámite ante AgendaYa.
5. Revocar la autorización o pedir que se borren tus datos, cuando no exista un deber legal o contractual de conservarlos.
6. Acceder gratis a tus datos personales.

## 9. Cómo ejercer tus derechos

Puedes hacer consultas y reclamos por dos canales: la sección PQRS de la app (Ayuda → PQRS) o el correo [CORREO DE CONTACTO]. Indica tu nombre, un dato de contacto y lo que pides. El área encargada de atenderlas es [NOMBRE DEL RESPONSABLE].

**Consultas** (conocer tus datos o su uso):

1. Se responden en máximo 10 días hábiles desde que se reciben.
2. Si no es posible en ese plazo, te informamos el motivo y la nueva fecha, que no superará 5 días hábiles más.

**Reclamos** (corregir, actualizar o borrar datos, o denunciar un incumplimiento):

1. Si el reclamo está incompleto, te pedimos lo que falta dentro de los 5 días siguientes. Si pasan 2 meses sin respuesta tuya, se entiende que desististe.
2. Si el reclamo corresponde a un negocio (por ejemplo, tus datos en su lista de clientes), se lo trasladamos en máximo 2 días hábiles y te informamos.
3. En máximo 2 días hábiles marcamos tus datos con la leyenda "reclamo en trámite" hasta resolverlo.
4. Se responde en máximo 15 días hábiles desde el día siguiente a su recibo. Si no es posible, te informamos el motivo y la nueva fecha, que no superará 8 días hábiles más.

Solo puedes acudir a la SIC después de agotar este trámite (artículo 16 de la Ley 1581 de 2012).

## 10. Seguridad

AgendaYa aplica medidas técnicas y administrativas para proteger los datos, entre ellas:

- Contraseñas guardadas con cifrado irreversible: nadie, ni siquiera el desarrollador, puede verlas.
- Comunicación cifrada entre la app y el servidor.
- Acceso por roles: cada persona ve solo lo que su rol permite.
- Límite de intentos de inicio de sesión y registro de accesos.
- Sesiones guardadas de forma cifrada en el celular.

Si ocurre un incidente de seguridad que ponga en riesgo los datos, AgendaYa lo informará a la SIC y a los afectados, según la ley.

## 11. Transmisión y transferencia de datos

- **Alojamiento:** los datos se guardan en servidores de [PROVEEDOR Y PAÍS DEL SERVIDOR], que actúa como Encargado bajo condiciones de seguridad y confidencialidad. Si el servidor está fuera de Colombia, se garantizará un nivel adecuado de protección o se pedirá la autorización correspondiente, según el artículo 26 de la Ley 1581 de 2012.
- **Negocios:** cada negocio solo accede a los datos de sus propios clientes, equipo y citas.
- **WhatsApp y Google Maps:** si un usuario toca el botón de WhatsApp o "Cómo llegar", la app abre esas aplicaciones, que tienen sus propias políticas de privacidad.
- **Autoridades:** solo se entregan datos ante requerimiento legal u orden judicial.

## 12. Conservación y supresión

Los datos se conservan mientras la cuenta esté activa y por el tiempo necesario para cumplir las finalidades y las obligaciones legales. Al eliminar una cuenta desde la app (Ayuda → Eliminar mi cuenta), los datos personales se borran o se anonimizan. Las citas y cifras de cartera del negocio se conservan sin datos que identifiquen a la persona.

## 13. Revocatoria de la autorización

Puedes revocar tu autorización en cualquier momento por los canales del numeral 9 o eliminando tu cuenta. La revocatoria no aplica cuando exista un deber legal o contractual de conservar los datos.

## 14. Cambios a esta Política

Cualquier cambio sustancial se publicará en la app con un nuevo número de versión. Si el cambio afecta la finalidad del tratamiento, se pedirá de nuevo la autorización antes de aplicarlo.

## 15. Vigencia

Esta Política rige desde [FECHA DE ENTRADA EN VIGENCIA]. Las bases de datos estarán vigentes mientras AgendaYa preste el servicio y por el tiempo que exija la ley.
$doc$
),
(
'terminos',
'1.0',
'Términos y Condiciones de Uso',
$doc$# Términos y Condiciones de Uso

**Versión 1.0 · Vigentes desde [FECHA DE ENTRADA EN VIGENCIA]**

Estos Términos regulan el uso de AgendaYa, plataforma operada por [NOMBRE DEL RESPONSABLE] ([IDENTIFICACIÓN]), con domicilio en [DOMICILIO].

## 1. Aceptación

Al marcar la casilla de aceptación y crear una cuenta o hacer una reserva, aceptas estos Términos y la Política de Tratamiento de Datos. Esta aceptación electrónica tiene validez según la Ley 527 de 1999. Si no estás de acuerdo, no uses la plataforma.

## 2. Qué es AgendaYa

AgendaYa es una herramienta para que negocios de servicios gestionen su agenda, equipo, servicios, productos y cartera, y para que sus clientes reserven citas.

AgendaYa no presta los servicios que se reservan (cortes, tratamientos, etc.). Esos servicios los presta cada negocio, que es el único responsable de su calidad, precio, cumplimiento y de sus propias políticas de atención.

## 3. Cuentas

- Para crear una cuenta debes ser mayor de 18 años y dar información veraz.
- Eres responsable de guardar tu contraseña y de lo que se haga con tu cuenta. Si sospechas un uso no autorizado, cambia tu contraseña y avísanos por PQRS.
- Existen cuatro tipos de usuario: administrador del negocio, integrante del equipo (administrador o empleado), cliente con cuenta y cliente invitado. Cada uno accede solo a las funciones de su rol.

## 4. Prueba gratuita y planes

- Cada negocio nuevo recibe una prueba gratuita de 15 días calendario, contados en hora de Colombia.
- Después de la prueba, el negocio necesita un plan activo (mensual o anual) para seguir usando las funciones de administración. Los planes se diferencian por el número máximo de personas en el equipo.
- Los pagos en línea aún no están disponibles. Cuando se habiliten, el precio, la forma de pago, la renovación y las condiciones de retracto o reembolso se informarán antes de cobrar, según la Ley 1480 de 2011.
- Si la prueba o el plan vence, el administrador podrá iniciar sesión y consultar "Mi negocio", pero no administrar la agenda, y los clientes no podrán hacer nuevas reservas. La información del negocio no se borra por el vencimiento.

## 5. Obligaciones del negocio

El negocio se compromete a:

1. Mantener actualizada y veraz la información pública (dirección, horario, servicios y precios).
2. Atender las citas reservadas o avisar a tiempo si las cancela.
3. Tratar los datos de sus clientes y de su equipo según la Ley 1581 de 2012. Frente a esos datos, el negocio es el Responsable y AgendaYa actúa como Encargado.
4. Contar con la autorización de cada integrante que registre en Equipo.
5. Usar la lista de bloqueados solo por razones legítimas, como inasistencias repetidas, y nunca con fines discriminatorios.

## 6. Obligaciones del cliente

- Dar un nombre y teléfono reales al reservar.
- Asistir a la cita o cancelarla con anticipación. El negocio puede restringir nuevas reservas de un teléfono con inasistencias repetidas.
- Respetar las políticas propias de cada negocio.

## 7. Reservas

- Las citas pueden reservarse desde el día actual y hasta 14 días después.
- Solo se ofrecen las horas que el negocio tiene disponibles; los horarios bloqueados o cerrados no pueden reservarse.
- Una reserva confirmada en la app no garantiza la prestación del servicio: esta depende del negocio.

## 8. Usos prohibidos

No está permitido:

- Crear reservas falsas o masivas, o usar datos de otras personas sin su autorización.
- Intentar acceder a cuentas, datos o funciones que no te corresponden.
- Interferir con el funcionamiento de la plataforma, copiarla o usar programas automáticos para extraer información.
- Publicar en fotos o textos contenido ilegal, ofensivo o que infrinja derechos de terceros.

El incumplimiento puede llevar a la suspensión o cancelación de la cuenta.

## 9. Propiedad intelectual

El software, el diseño, la marca AgendaYa y sus contenidos pertenecen a [NOMBRE DEL RESPONSABLE]. El negocio conserva los derechos sobre las fotos y textos que sube, y autoriza a AgendaYa a mostrarlos dentro de la plataforma para prestar el servicio.

## 10. Disponibilidad

AgendaYa busca funcionar de forma continua, pero puede haber interrupciones por mantenimiento, fallas técnicas o causas ajenas a su control. Se procurará avisar con anticipación de los mantenimientos programados.

## 11. Responsabilidad

AgendaYa responde por el correcto funcionamiento de la plataforma según estos Términos. No responde por la calidad o el cumplimiento de los servicios de cada negocio, ni por el uso indebido que un usuario haga de su cuenta. Nada en estos Términos limita los derechos irrenunciables que la ley colombiana reconoce a los consumidores.

## 12. Suspensión y eliminación de la cuenta

- Puedes eliminar tu cuenta en cualquier momento desde Ayuda → Eliminar mi cuenta. El efecto sobre tus datos está descrito en la Política de Tratamiento de Datos.
- AgendaYa puede suspender una cuenta que incumpla estos Términos, informando el motivo al titular.

## 13. Notificaciones

Si las activas, la app puede enviarte notificaciones sobre tus citas (recordatorios y cancelaciones). Puedes desactivarlas desde la configuración del celular.

## 14. Datos personales

El tratamiento de datos personales se rige por la Política de Tratamiento de Datos Personales de AgendaYa, que forma parte de estos Términos.

## 15. Cambios a estos Términos

Los cambios se publicarán en la app con un nuevo número de versión y se pedirá aceptarlos de nuevo. Si no los aceptas, puedes dejar de usar la plataforma y eliminar tu cuenta.

## 16. Ley aplicable y contacto

Estos Términos se rigen por las leyes de la República de Colombia. Para peticiones, quejas, reclamos o sugerencias, usa la sección PQRS de la app o escribe a [CORREO DE CONTACTO]. También puedes acudir a la Superintendencia de Industria y Comercio en los casos que la ley permita.
$doc$
),
(
'aviso_privacidad',
'1.0',
'Aviso de privacidad',
$doc$**[NOMBRE DEL RESPONSABLE]**, responsable de AgendaYa ([CORREO DE CONTACTO], [TELÉFONO]), tratará tus datos (nombre, teléfono, correo y citas) para gestionar tu cuenta y tus reservas, enviarte avisos sobre tus citas y atender tus solicitudes. Los datos de tus reservas también los trata el negocio donde reservas. Tienes derecho a conocer, actualizar, rectificar y suprimir tus datos, y a revocar esta autorización, desde Ayuda → PQRS o escribiendo al correo indicado. Consulta la Política de Tratamiento de Datos completa en la app.
$doc$
);
