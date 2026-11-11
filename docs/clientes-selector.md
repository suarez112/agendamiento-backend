# Selector de cliente existente (`GET /api/v1/clientes/buscar`)

Busca clientes del negocio para elegir un "cliente existente" (por ejemplo en Nueva cita, `POST /citas/panel` con `clienteId`). Sirve al **administrador** (integrante con rol Administrador o cuenta de administración) y al **empleado** del mismo negocio. `GET /clientes` sigue siendo solo para administradores.

## Acceso

- Sesión del personal (`Authorization: Bearer <token>`) con la suscripción vigente: **401** sin sesión, **403** con la cuenta de un cliente, **402** si el negocio está vencido.
- El negocio sale **siempre de la sesión**. Un `empresaId` (o cualquier otro parámetro) en la URL se ignora.

## Parámetros

| Parámetro | Regla |
| --- | --- |
| `q` | Obligatorio. De **3 a 100 caracteres**; ninguno de los dos límites cuenta los espacios de los extremos. |

No hay `limite` ni `cursor`: la respuesta trae como máximo **10 clientes**. Para encontrar a alguien que no aparece hay que escribir más.

## Qué busca

- **Nombre**: siempre, sin distinguir mayúsculas, en cualquier parte del nombre. `%` y `_` se buscan como texto.
- **Teléfono**: solo si la sesión puede ver teléfonos (ver abajo) y el texto parece un número (solo dígitos, espacios, `+`, `-`, `.` o paréntesis) con **al menos 3 dígitos**. Compara los dígitos, así `315 777-1234` encuentra `+573157771234`. `+57` (2 dígitos) no busca por teléfono. Un empleado solo encuentra por teléfono a **sus propios clientes** (ver abajo).
- Orden: el de la lista de clientes (última cita más reciente primero, luego nombre).

## Privacidad del teléfono

La regla es la misma de toda la API (`puedeVerTelefonos` + `telefonoVisible`, `src/modules/clientes/privacidad.ts`):

| Quién | Opción `empleadosVenTelefono` | Cliente | `telefono` / `indicativo` | Busca por su teléfono |
| --- | --- | --- | --- | --- |
| Administrador | apagada o encendida | cualquiera del negocio | con valor | sí |
| Empleado | apagada (por defecto) | cualquiera | `null` | **no**: solo por nombre |
| Empleado | encendida | **propio** (tiene o tuvo citas con él) | con valor | sí |
| Empleado | encendida | **ajeno** (sin citas con él) | `null` | **no** |

- **Propio**: el cliente tiene o tuvo al menos una cita con ese empleado, de cualquier estado (pendiente, completada o cancelada). La relación es con cada empleado: lo que ve uno no lo ve otro.
- El nombre del cliente ajeno **siempre aparece** (para poder elegirlo), pero buscar por su teléfono, completo o parcial, no lo encuentra y responde igual que un número que no existe: la búsqueda no confirma de quién es un número.
- Con la opción apagada, y con un cliente ajeno aunque esté encendida, los campos `telefono` e `indicativo` **siguen en la respuesta**, en `null`: la forma es siempre la misma.
- La opción y la relación se leen en cada solicitud: un cambio aplica en la siguiente, con el mismo token.
- En la agenda y en la respuesta de `POST /citas/panel` el empleado ve solo los teléfonos de las citas que son suyas, como antes.

### Límite conocido

Si un empleado agenda con `clienteId` a un cliente que **no era suyo**, esa cita lo convierte en cliente suyo: la respuesta de `POST /citas/panel` y, desde ese momento, la agenda y el selector le muestran su teléfono (con la opción encendida). Obtener el teléfono así exige crear una cita real (queda en la agenda del negocio y avisa al cliente si tiene cuenta). No hay hoy ningún control adicional sobre esto.

## Respuesta

**200**

```json
{
  "datos": [
    { "id": "…", "nombre": "Valeria Gómez", "telefono": null, "indicativo": null }
  ],
  "hayMas": false,
  "telefonosVisibles": false
}
```

- `datos`: hasta 10 clientes.
- `hayMas`: `true` si hay más de 10 coincidencias (la app puede pedir que se escriba más).
- `telefonosVisibles`: si esta sesión puede ver teléfonos. Para un empleado con la opción encendida es `true`, pero solo los de sus propios clientes llegan con valor: cada cliente trae su `telefono` o `null`. Sirve para el texto de ayuda del buscador; la app no debe deducir de ahí si un cliente concreto tiene teléfono visible, sino de su propio `telefono`.

## Errores

| Código | Mensaje |
| --- | --- |
| 400 | `Escribe al menos 3 caracteres para buscar` (sin `q`, vacío o menos de 3) |
| 400 | `La búsqueda puede tener hasta 100 caracteres` |
| 400 | `La búsqueda debe ser un texto` (`q` repetido o con caracteres no válidos) |
| 401 / 402 / 403 | Los comunes de los endpoints del personal |

## Código y pruebas

- Ruta: `src/modules/clientes/clientes.rutas.ts`; servicio: `buscarParaSelector`; consulta: `buscarClientesSelector` (`clientes.repositorio.ts`), que comparte la condición de búsqueda con `GET /clientes?q=`.
- Pruebas: `test/clientesSelector.test.ts` y el barrido de `test/privacidadTelefonos.test.ts`.
