/**
 * [2026-09-11] Un turno por conversación, a la vez.
 *
 * El problema que resuelve, visto en producción el 2026-09-11: el cliente mandó su nombre, su
 * cédula y su celular en tres mensajes seguidos, casi al mismo tiempo. Cada mensaje entra a la
 * cola como un trabajo independiente y el worker corre hasta 5 en paralelo (ver
 * worker/inboundWorker.ts), así que DOS de esos mensajes se procesaron a la vez para el mismo
 * cliente. Resultado: se crearon dos reservas y se le mandaron dos links de pago distintos por
 * la misma estadía. Con dinero de por medio eso no es un detalle — es cobrar dos veces y
 * bloquear dos cupos.
 *
 * La causa de fondo es que el turno NO es una operación independiente: lee el historial, lo
 * modifica, consulta la base y escribe en ella. Dos turnos de la misma conversación pisándose
 * es una carrera clásica.
 *
 * La solución acá es la más simple que funciona de verdad: una fila por conversación dentro del
 * proceso. Cada mensaje espera a que termine el anterior de ESA conversación; conversaciones
 * distintas siguen corriendo en paralelo, así que no se pierde velocidad donde importa.
 *
 * OJO con el alcance: esto serializa dentro de UN proceso worker. Hoy hay uno solo, así que
 * alcanza. Si algún día se corren varios workers en paralelo (para escalar), esta fila ya no
 * basta y hay que mover el candado a Redis — dejar dicho acá para que no se descubra tarde.
 */

/** Última tarea encolada por conversación. Nunca rechaza, para no cortar la cadena. */
const filaPorConversacion = new Map<string, Promise<void>>();

/** Cuántas conversaciones tienen algo en curso o esperando (para los logs / diagnóstico). */
export function conversacionesEnCurso(): number {
  return filaPorConversacion.size;
}

/**
 * Corre `tarea` cuando le toque el turno a `clave` (normalmente "canal:externalId").
 * Devuelve lo que devuelva la tarea, y propaga su error a quien llama — así BullMQ sigue viendo
 * los fallos y reintentando como siempre.
 */
export async function enTurnoPorConversacion<T>(clave: string, tarea: () => Promise<T>): Promise<T> {
  const anterior = filaPorConversacion.get(clave) ?? Promise.resolve();

  // `then(tarea, tarea)`: la tarea corre aunque la anterior de esta misma conversación haya
  // fallado — un mensaje que falló no puede dejar al cliente sin respuesta en los siguientes.
  const resultado = anterior.then(tarea, tarea);

  // En la cadena guardamos una versión que NUNCA rechaza: si guardáramos `resultado` tal cual,
  // un fallo dejaría la cadena en estado rechazado y (peor) generaría un unhandledRejection.
  const eslabon: Promise<void> = resultado.then(
    () => {},
    () => {}
  );
  filaPorConversacion.set(clave, eslabon);

  // Limpieza: si nadie encoló detrás mío, saco la clave para no acumular memoria con cada
  // conversación que pasó alguna vez por acá.
  void eslabon.then(() => {
    if (filaPorConversacion.get(clave) === eslabon) filaPorConversacion.delete(clave);
  });

  return resultado;
}
