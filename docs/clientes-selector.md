# Selector de cliente existente (`GET /api/v1/clientes/buscar`)

Busca clientes para elegir un "cliente existente" (por ejemplo en Nueva cita, `POST /citas/panel` con `clienteId`). Sirve al **administrador** (integrante con rol Administrador o cuenta de administración), que busca entre **todos** los clientes del negocio, y al **empleado** del mismo negocio, que busca **solo entre sus propios clientes**: los que tienen o tuvieron citas con él. `GET /clientes` sigue siendo solo para administradores.

## Acceso

- Sesión del personal (`Authorization: Bearer <token>`) con la suscripción vigente: **401** sin sesión, **403** con la cuenta de un cliente, **402** si el negocio está vencido.
- El negocio sale **siempre de la sesión**. Un `empresaId` (o cualquier otro parámetro) en la URL se ignora.

## Parámetros

| Parámetro | Regla |
| --- | --- |
| `q` | Obligatorio. De **3 a 100 caracteres**; ninguno de los dos límites cuenta los espacios de los extremos. |

No hay `limite` ni `cursor`: la respuesta trae como máximo **10 clientes**. Para encontrar a alguien que no aparece hay que escribir más.

## Qué busca

- **Quién**: el administrador, a todos los clientes del negocio; el empleado, solo a los que tienen o tuvieron al menos una cita con él, de cualquier estado (pendiente, completada o cancelada). Los demás clientes del negocio **no aparecen para el empleado**, ni por nombre ni por teléfono, con la opción de teléfonos encendida o apagada.
- **Nombre**: siempre, sin distinguir mayúsculas, en cualquier parte del nombre. `%` y `_` se buscan como texto.
- **Teléfono**: solo si la sesión puede ver teléfonos (ver abajo) y el texto parece un número (solo dígitos, espacios, `+`, `-`, `.` o paréntesis) con **al menos 3 dígitos**. Compara los dígitos, así `315 777-1234` encuentra `+573157771234`. `+57` (2 dígitos) no busca por teléfono. El empleado solo busca por teléfono con la opción encendida, y siempre entre sus propios clientes.
- Orden: el de la lista de clientes (última cita más reciente primero, luego nombre).

## Privacidad del teléfono

La regla es la misma de toda la API (`puedeVerTelefonos` + `telefonoVisible`, `src/modules/clientes/privacidad.ts`):

| Quién | Opción `empleadosVenTelefono` | Clientes que ve | `telefono` / `indicativo` | Busca por teléfono |
| --- | --- | --- | --- | --- |
| Administrador | apagada o encendida | todos los del negocio | con valor | sí |
| Empleado | apagada (por defecto) | solo los suyos | `null` | **no**: solo por nombre |
| Empleado | encendida | solo los suyos | con valor | sí, entre los suyos |

- **Suyos**: el cliente tiene o tuvo al menos una cita con ese empleado, de cualquier estado. La relación es con cada empleado: lo que ve uno no lo ve otro.
- Un cliente de otro empleado o sin citas con el empleado no aparece, y buscar su teléfono, completo o parcial, responde igual que un número que no existe: la búsqueda no confirma de quién es un número ni si existe el cliente.
- Con la opción apagada los campos `telefono` e `indicativo` **siguen en la respuesta**, en `null`: la forma es siempre la misma. La respuesta no trae ningún campo que marque si un cliente es propio: todos los que llegan al empleado lo son.
- La opción y la relación se leen en cada solicitud: un cambio aplica en la siguiente, con el mismo token.
- En la agenda y en la respuesta de `POST /citas/panel` el empleado ve solo los teléfonos de las citas que son suyas, como antes.

### Agendar con un cliente existente

Un empleado solo puede **agendar** (`POST /citas/panel` con `clienteId`) a clientes que tienen o tuvieron citas con él, de cualquier estado, **con la opción de teléfonos encendida o apagada**. Si el `clienteId` es de un cliente de otro empleado o sin citas con él, responde **404** `Cliente no encontrado`, igual que si el cliente no existiera (no se distingue el motivo). El administrador agenda a cualquier cliente del negocio. Como el selector solo le muestra al empleado a sus clientes, todo lo que elige ahí se puede agendar. Un cliente nuevo (nombre y teléfono escritos) sigue permitido.

### Nombre que ve el empleado

Cada cita creada desde el panel guarda el nombre que escribió quien agendó (`citas.cliente_nombre`, migración 037). Si el teléfono escrito ya es de un cliente del negocio (por ejemplo, de otro empleado), se reutiliza ese cliente sin cambiar su nombre guardado, pero el empleado **nunca ve el nombre guardado**:

| Dónde | Empleado | Administrador |
| --- | --- | --- |
| Respuesta de `POST /citas/panel` | lo que escribió (o, con `clienteId`, el nombre que él ve) | lo que escribió, o el guardado con `clienteId` |
| `GET /citas/agenda` | el nombre escrito en esa cita; si no tiene, el guardado | el guardado |
| Este selector | el nombre escrito en su cita más reciente con ese cliente; si ninguna lo tiene, el guardado | el guardado |

- El empleado **busca por el nombre que ve**: buscar el nombre guardado de un cliente que él registró con otro nombre no lo encuentra.
- La respuesta de `POST /citas/panel` es idéntica exista o no un cliente con ese teléfono.
- Las citas anteriores a la migración (y las reservas que hacen los clientes) no tienen nombre escrito: muestran el guardado, como antes.
- Si el cliente elimina su cuenta, el nombre escrito en sus citas también se borra.
- Un empleado puede crear hasta 10 citas por minuto y 60 por hora desde el panel (**429** al pasarse); el administrador no tiene este tope.

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
- `telefonosVisibles`: si esta sesión puede ver teléfonos. Para un empleado es `true` solo con la opción del negocio encendida; entonces todos los clientes de la respuesta (son suyos) traen su `telefono`. Sirve para el texto de ayuda del buscador.

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
