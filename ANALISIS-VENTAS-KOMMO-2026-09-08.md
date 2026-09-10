# Cómo venden hoy en La Julita — análisis del CRM (Kommo), 2026-09-08

Fuente: cuenta `lajulitaglamping` en Kommo. Se leyó el embudo completo (29 etapas, 4.629 leads
activos, 5.064 chats) y transcripciones completas de tres conversaciones representativas: una
reserva pagada de pasadía, una reserva de alojamiento con objeción de desconfianza resuelta, y
una que murió en "info enviada". Los nombres de clientes se omiten a propósito.

## 1. El embudo real, con volúmenes

| Etapa | Leads |
|---|---|
| Leads entrantes | 199 |
| Nuevos leads | 2 |
| **Info enviada** | **716** |
| Eliminar chats | 591 |
| Viernes | 305 |
| Interesado septiembre 5-6 / 12-13 / 19-20 / 26-27 | 254 / 223 / 227 / 114 |
| Interesados fin de semana octubre 3-4 / 10-12 / 17-18 / 24-25 | 48 / 66 / 18 / 10 |
| Familias fin de semana / entre semana interesadas | 128 / 24 |
| Personas solas entre semana / fin de semana | 49 / 26 |
| Pasadía interesados | 58 |
| Plan chicas | 7 |
| Reserva interesada a largo plazo | 136 |
| **Cliente pendiente de pago** | **109** |
| **Fin de semana que pasó, no tomaron cupo** | **557** |
| Remarketing entre semana | 574 |
| Contactos para remarketing que ya nos visitaron | 140 |
| Ganadores live / Closed won ganadores live | 17 / 6 |
| **Reserva confirmada guías** | **7** |
| Malos clientes | 17 |

**Lo que grita este embudo:** 716 leads con información enviada, 109 pendientes de pago y 557
que dejaron pasar el fin de semana sin tomar cupo. La fuga no está en atraer clientes — está
entre "ya le mandé los precios" y "pagó".

El embudo también revela cómo segmentan de verdad: **por fecha de fin de semana** y **por tipo
de grupo** (pareja, familia, personas solas, amigas, pasadía). Eso es exactamente lo que el bot
debe capturar en la conversación.

## 2. El guion que sí usan (extraído literal de los chats)

### 2.1 Saludo automático del SalesBot — pide dos datos de una

> ✨ ¡Hola! {nombre}, soy **Estefany** 👩‍💻 de La Julita Glamping 🌿🏕️
> Me encantaría ayudarte a elegir el plan perfecto.✨
> 🎁 *Promo activa de lunes a viernes en plan descanso premium, lujo y todo incluido para dos personas* 🎁
> 📌 Al continuar aceptas nuestra política de datos 👉 lajulitaglamping.com.co
> Cuéntame por favor 👇
> 👥 ¿Cuántas personas vienen?
> 📆 ¿Para qué fecha?

Aprendizajes: hay **una persona con nombre (Estefany)**, se pide **personas + fecha juntas**
(no de a una), se mete un **gancho de promo** desde el primer mensaje, y se avisa la política de
datos. Fuera de horario hay un saludo nocturno distinto que además ofrece el motor de reservas
en línea (LobbyPMS).

### 2.2 El mensaje que de verdad vende: TRES experiencias, no veinte planes

> Elige tu experiencia ideal una noche dos personas de Lunes a Jueves:
>
> 🏕️🌙 **Planes por noche** — Incluye noche, jacuzzi y desayuno. Agrega la decoración que
> prefieras por valor adicional 🎈💐 · Entre semana **desde $399.000** (promoción reservando hoy)
>
> 💛 **Planes Intermedios** — Noche, desayuno, jacuzzi, cena y decoración especial ·
> Entre semana **desde $629.000**
>
> 🌟🥂 **Planes Todo Incluido** — Noche, cena romántica, jacuzzi, desayuno, fogata, spa,
> coctelería, servicio a la habitación y más 💕🔥🍽️ · Entre semana **desde $1.279.000**
>
> ¿Cuál de estas experiencias quieres vivir? 💑✨

Esto es lo más importante de todo el análisis. **No listan planes: ofrecen tres niveles de
experiencia**, con "desde", con los beneficios que se sienten (jacuzzi, cena romántica, spa,
fogata) y cerrando con una pregunta de elección. El nombre del plan puntual aparece **después**,
cuando el cliente elige un nivel.

### 2.3 Detalle de un plan (cuando el cliente ya eligió)

Lista con un emoji por ítem y el valor al final: *"Valor para dos personas $369.000 precio sin
IVA"*. Siempre aclaran **precio sin IVA** y el check-in/check-out del plan.

### 2.4 Políticas de reserva (mensaje fijo, va antes de cobrar)

- **Alojamiento: abono del 50%.** El 50% restante: viernes, sábados, domingos de puente,
  pasadías y 24/31 de diciembre se paga **un día antes del check-in** (si no, se cancela la
  reserva); de domingo a jueves **se paga al llegar**.
- **Pasadías y ganadores de live: 100% por adelantado.**
- Menores sin sus padres necesitan permiso autenticado por notaría.
- Términos y condiciones son 2 páginas y hay que leerlos antes de pagar.
- Medios de pago: **Llave / QR Bre-B** (sin costo) o **link de tarjeta de crédito (+6%)**.
- Cierre de pago con elección binaria: *"¿Te envío QR (llave) o link de pago (con link te
  aumenta el 6%)?"*
- Al enviar los datos de pago: piden **nombres completos y cédulas** de los huéspedes y avisan
  *"si no puedes hacer la reserva en una hora, escríbenos antes de transferir para confirmarte
  disponibilidad"* — urgencia real, sin inventar escasez.

### 2.5 Objeción de desconfianza (la que decide muchas ventas)

Una clienta pidió RUT y RNT antes de pagar. La secuencia que funcionó:

- "Tenemos más de 500 reseñas en Google Maps… de personas reales que nos han visitado"
- Envío de los documentos y de números para verificar identidad
- "Hacemos live diariamente" y "videollamadas de lunes a viernes"
- Y el remate que desarma: *"si no te sientes cómoda con las políticas de reserva es
  completamente válido; puedes reservar como más segura te sientas"*

Sin presión, con prueba social y verificación. La clienta pagó minutos después.

### 2.6 Después del pago

Comprobante → **guía del glamping (PDF)** → y un cuestionario de llegada: hora de llegada, zona
de Bogotá de la que sale, medio de transporte, tipo de celebración y mensaje del tablero para la
decoración (máx. 10 palabras, y si quiere vino tinto/rosa/blanco o champaña), si pagó spa (qué
traer) y **"¿por dónde nos conociste?"** (Instagram, TikTok, web, recomendación).

Ruta de llegada: **solo Google Maps, NO Waze**, punto de referencia "Piqueteadero Puerto
Lleras", vereda Anatolí, video obligatorio, y a quién preguntar si se pierden.

Antes de la llegada mandan una difusión recordando hora máxima de ingreso (8:00 p. m.), que el
100% debe estar pago un día antes, y **hacen upsell**: coctelería, spa, turco, video recuerdo,
decoraciones románticas.

## 3. Dónde se pierde la plata (evidencia directa)

**Caso real de hoy:** una clienta escribió a las **6:54 a. m.** — "2 personas para hoy 😬" y a
las 7:03 "¿qué me puede ofrecer?". La respuesta humana llegó a las **8:03 a. m.**, una hora
después, con el menú de tres experiencias. La clienta **nunca volvió a escribir** y el lead
quedó en "info enviada". Quería ir ESE MISMO DÍA.

En otra conversación, la vendedora escribió textual: *"discúlpame estaba en live no te puedo
responder rápido"*.

Los tres huecos, en orden de plata perdida:

1. **Tiempo de respuesta.** Cuando el equipo está en live o durmiendo, el cliente caliente se
   enfría. Un bot que contesta en 3 segundos, 24/7, con el mismo guion, es la mayor ganancia
   disponible.
2. **Cero seguimiento tras mandar precios.** 716 leads en "info enviada" y 557 que dejaron
   pasar el fin de semana. Nadie los retoma automáticamente. (Ya construido: cadena de
   recontacto a 20 min / 3 h / 6 h.)
3. **Nadie pide la fecha con intención de cerrar.** El menú cierra con "¿cuál experiencia
   quieres vivir?" pero no con "¿te aparto el cupo para el sábado?".

## 4. Cosas del negocio que el bot todavía no sabe (y debería)

- **Los precios del CRM no coinciden con la tabla `planes` de Supabase.** Las vendedoras
  cotizan "por noche desde $399.000 (promo de hoy)" e "intermedios desde $629.000"; en Supabase
  el básico está en $569.000 y el intermedio más barato en $790.000. Solo "todo incluido
  $1.279.000" coincide. Hay que decidir cuál manda y sincronizar.
- **Existe un motor de reservas en línea** (`engine.lobbypms.com/la-julita-glamping`). Ahí vive
  la disponibilidad real, que hoy el bot no consulta (la tabla `reservas` está vacía).
- **Promos por día**: "promo activa de lunes a viernes en descanso premium, lujo y todo
  incluido", "promoción reservando hoy". Hoy no hay dónde cargarlas.
- **Precios sin IVA** — el bot nunca lo aclara y las vendedoras siempre lo dicen.
- **Adicionales como upsell post-reserva**: coctelería, spa, turco, video recuerdo, decoración.
- **Datos que piden siempre para cerrar**: nombres completos y cédulas de todos los huéspedes.

## 5. Qué se aplicó al bot a partir de esto

1. Persona **Estefany** de La Julita Glamping, con la política de datos en el primer mensaje.
2. Se pregunta **personas + fecha** (como ellas), y la ocasión cuando aporta.
3. El pitch pasa de listar planes a **tres niveles de experiencia con "desde"**, cerrando con
   "¿cuál de estas experiencias quieres vivir?".
4. Precio **de la fecha del cliente** y aclaración de que es sin IVA.
5. Guion de **políticas de reserva** (50% / 100%, saldo, medios de pago, +6% con tarjeta) y
   cierre binario QR vs link.
6. Guion de **objeción de desconfianza** con las 500 reseñas, RUT/RNT, lives y videollamadas, y
   el cierre sin presión.
7. **Recontacto automático** a 20 min / 3 h / 6 h para los 716 de "info enviada" que hoy nadie
   retoma.
