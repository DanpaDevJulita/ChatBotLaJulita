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
