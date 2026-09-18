# IP del servidor autorizada en LobbyPMS

LobbyPMS exige que la IP de SALIDA del servidor que corre el bot esté autorizada en su panel
(Configuraciones → API → restricciones de IP). Si no lo está, la API oficial responde 403 y el
bot cae al motor público de LobbyPMS (ver `src/core/integrations/lobbypms.ts`) — sigue
funcionando, pero con menos datos.

## IP actual (confirmada por el error real del 2026-09-13)

```
143.105.99.243
```

Salió de este mensaje en los logs de producción:

```
[lobbypms] API oficial no disponible (ip_no_autorizada): LobbyPMS rechazó la IP de este servidor.
Hay que autorizarla en el panel de LobbyPMS (Configuraciones -> API -> restricciones de IP).
[HTTP 403 — ... — ["the 143.105.99.243 trying to access the API is not set as a valid ip"]]
```

**Si el bot se muda de servidor (otro hosting, otro plan, IP dinámica que cambió), esta IP deja
de servir** — hay que repetir el proceso: ver qué IP rechaza LobbyPMS en el log de ese momento
(el mensaje de error siempre la trae, tal como pasó acá) y autorizar la nueva en el panel.

## ⚠️ Esta IP casi seguro NO es fija — cómo se despliega hoy el bot

[2026-09-13] Daniel confirmó que despliega así: corre el bot en su propia máquina
(`http://localhost:3000`) y lo expone a internet con un **quick tunnel de Cloudflare**
(`cloudflared tunnel --url http://localhost:3000` — sin dominio propio, genera una URL
`*.trycloudflare.com` distinta cada vez que se reinicia).

Eso resuelve el tráfico ENTRANTE (que YCloud y Bold puedan mandarle webhooks a la máquina de
Daniel). Pero las llamadas SALIENTES del bot hacia la API de LobbyPMS NO pasan por Cloudflare:
salen directo desde la conexión a internet de esa máquina — típicamente la IP pública que el ISP
(el proveedor de internet de casa u oficina) le asigna al router. La inmensa mayoría de esos
planes de internet residenciales/de oficina en Colombia usan **IP dinámica**: cambia cuando el
router se reconecta, hay un corte de luz, o el ISP renueva el lease — sin avisar y sin que Daniel
haga nada.

**Consecuencia práctica: `143.105.99.243` puede dejar de ser la IP correcta en cualquier
momento**, y el error `ip_no_autorizada` va a volver a aparecer cada vez que cambie — no es un
bug del código, es que la IP real cambió. Por ahora la única señal de que cambió es ese mismo
error en los logs (siempre trae la IP nueva).

**Esto es justo lo que le pega a la idea de "alta disponibilidad"** que Daniel mencionó antes
(200+ conversaciones en paralelo): una máquina personal con un quick tunnel de Cloudflare no es
un despliegue pensado para eso — ni la IP es estable, ni el proceso sigue corriendo si esa
máquina se apaga, se reinicia, pierde internet, o el `cloudflared` se cae (y las URLs
`trycloudflare.com` cambian en cada reinicio del túnel, lo que además obliga a reconfigurar
YCloud y Bold cada vez — ya pasó en esta conversación).

Opciones para resolverlo de raíz (para cuando Daniel quiera retomarlo):
1. **Pedir al ISP una IP fija** (muchos planes de negocio la ofrecen) — resuelve solo el
   problema de LobbyPMS, pero el bot sigue dependiendo de que esa máquina y el túnel estén
   siempre prendidos y conectados.
2. **Mover el bot a un hosting real** (un VPS o un servicio tipo Render/Railway) con IP de salida
   fija y sin depender de la máquina de Daniel — resuelve LobbyPMS Y el resto de la
   disponibilidad de una sola vez. Es lo recomendable si de verdad se espera tráfico alto.

### Decisión (2026-09-13): así se queda MIENTRAS es ambiente de pruebas

Daniel decidió no tocar nada de esto todavía — es exactamente el trade-off correcto para un
ambiente de pruebas: no vale la pena pedir IP fija ni montar un hosting real solo para probar.
**Mientras se siga probando así, cada vez que cambie la IP (el error `ip_no_autorizada` avisa
solo) se reautoriza la nueva en el panel de LobbyPMS y ya.**

**Pero esto NO se puede quedar así cuando el bot pase a producción de verdad** (clientes reales,
alta disponibilidad, 200+ conversaciones a la vez): ahí sí hay que resolverlo de raíz —lo más
razonable en ese momento es la opción 2 (hosting real con IP de salida fija), porque de paso
resuelve también que el proceso no dependa de que la máquina de Daniel esté prendida. Vale la
pena retomar esta conversación como parte del checklist de "qué falta antes de pasar a
producción".

## Dónde se autoriza

Panel de LobbyPMS → Configuraciones → API → restricciones de IP. La pregunta sobre si acepta
varias IPs y/o rangos (CIDR) quedó sin responder de soporte — ver `MENSAJE-SOPORTE-LOBBYPMS.md`.

## Por qué esto importa

Sin la IP autorizada, el bot pierde acceso a disponibilidad real de LobbyPMS y usa el motor
público como respaldo (funciona, pero es menos preciso). No es un error que tumbe el bot — el
código ya está pensado para seguir funcionando sin la API oficial — pero conviene tenerla
autorizada siempre que se pueda.

## Actualización 2026-09-16: la IP volvió a cambiar (como se esperaba)

Confirmado con este mensaje en los logs de producción:

```
[lobbypms] API oficial no disponible (ip_no_autorizada): LobbyPMS rechazó la IP de este servidor.
[HTTP 403 — ... — ["the 179.238.3.153 trying to access the API is not set as a valid ip"]]
```

La IP autorizada hasta ahora (`143.105.99.243`, del 2026-09-13) dejó de servir. **Nueva IP a
autorizar en el panel de LobbyPMS: `179.238.3.153`.**

Van dos cambios de IP en tres días de uso real — confirma que, mientras el bot siga corriendo
desde la máquina de Daniel con IP dinámica del ISP, esto va a seguir pasando cada tanto (no es
un bug, es el trade-off ya aceptado para el ambiente de pruebas — ver sección de arriba). El
bot no se cae cuando pasa: sigue respondiendo con el motor público mientras se reautoriza.

---

## RESUELTO 2026-09-18: el bot se mudó a Fly.io y la IP ahora es fija

Se hizo lo que este documento venía recomendando como "opción 2": mover el bot a un hosting real
con IP de salida fija. Ya no hay que reautorizar nada cada pocos días.

**La IP a autorizar en LobbyPMS es:**

```
209.71.78.239
```

Es una *egress IP* de Fly, asignada a la app `botlajulita` en la región `gru` (São Paulo) con:

```bash
fly ips allocate-egress --app botlajulita -r gru
```

Cuesta USD 3.60/mes, está atada a la app (no a una máquina), y **sobrevive a los despliegues y a
que las máquinas se recreen**. Solo se libera corriendo `fly ips release-egress` a mano. Se
consulta cuando haga falta con `fly ips list --app botlajulita`.

### La trampa del IPv6 — por qué hizo falta una línea extra

`api.lobbypms.com` está detrás de Cloudflare y **tiene registro AAAA**
(`2606:4700:20::681a:ba`). La documentación de Fly advierte que sus máquinas suelen salir por
IPv6 cuando el destino tiene AAAA. Si eso pasaba, LobbyPMS habría visto la IPv6 de la app y
habría seguido respondiendo 403 **aunque la IPv4 estuviera autorizada** — el mismo síntoma de
siempre, con una causa completamente distinta y mucho más difícil de adivinar.

Por eso el `fly.toml` declara:

```toml
NODE_OPTIONS = "--dns-result-order=ipv4first"
```

Eso hace que Node prefiera IPv4 al resolver nombres. Todos los servicios que usa el bot
(Supabase, OpenRouter, YCloud, Bold, Upstash) responden por IPv4, así que no rompe nada.

**Si alguna vez vuelve a aparecer `ip_no_autorizada`, lo primero que hay que mirar es si esa
línea sigue en el `fly.toml`.** El error trae la IP que LobbyPMS ve: si es una dirección IPv6,
la causa es esa y no que la IP haya cambiado.

### Lo que queda del montaje viejo

Las IPs `143.105.99.243`, `179.238.3.153` y `34.123.130.11` que están en la lista blanca vienen
de cuando el bot corría en la máquina de Daniel con IP dinámica del ISP. Una vez confirmado que
la IP de Fly funciona, se pueden borrar del panel de LobbyPMS — ya no las usa nadie, y dejarlas
autorizadas es acceso concedido a direcciones que hoy le pertenecen a cualquier otro.
