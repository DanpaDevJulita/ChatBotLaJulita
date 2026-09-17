import { supabase, supabaseConfigured } from "./supabase.js";

/**
 * Tickets de errores — la misma tabla `tickets` que administra el panel (LaJulitaWeb).
 *
 * El bot solo hace una cosa aquí: cuando detecta una falla técnica, deja un ticket para que
 * el equipo la vea en el panel, con estado y responsable, en vez de que el aviso se pierda
 * en un correo. No lee ni cierra tickets: eso es trabajo de las personas.
 *
 * La gracia está en NO duplicar. Una falla como "lobbypms:ip_no_autorizada" puede dispararse
 * cientos de veces en una hora; si cada una abriera un ticket, la pantalla sería inservible.
 * Por eso mientras exista un ticket vivo (abierto o en progreso) con esa misma `clave_bot`,
 * solo le subimos el contador `veces` y refrescamos el detalle. Cuando alguien lo resuelve,
 * la siguiente ocurrencia abre uno nuevo — que es la señal correcta: volvió a pasar.
 *
 * Nota: la tabla tiene un índice único parcial sobre `clave_bot` para los tickets vivos, así
 * que aunque dos mensajes entren a la vez, la base impide el duplicado.
 */

/** Cuán grave es cada familia de fallas. Lo que rompe una reserva o un pago es crítico. */
function prioridadDe(clave: string): "media" | "alta" | "critica" {
  if (clave.startsWith("bold:") || clave.startsWith("pagos:")) return "critica";
  if (clave.startsWith("lobbypms:") || clave.startsWith("supabase:")) return "alta";
  return "media";
}

/** Un título legible para alguien que no conoce las claves internas. */
function tituloDe(clave: string, detalle: string): string {
  const [servicio, motivo] = clave.split(":");
  const servicioBonito = servicio ? servicio.toUpperCase() : "Bot";
  const motivoBonito = (motivo ?? "").replace(/_/g, " ").trim();
  const base = motivoBonito ? `${servicioBonito}: ${motivoBonito}` : `${servicioBonito}: falla tecnica`;
  return base.slice(0, 180) || detalle.slice(0, 180);
}

/**
 * Abre un ticket por esta falla, o suma una ocurrencia si ya hay uno vivo.
 * Nunca lanza: un problema registrando el ticket no puede tumbar la conversación con el cliente.
 */
export async function abrirTicketTecnico(clave: string, detalle: string): Promise<void> {
  if (!supabaseConfigured) return;

  try {
    const { data: vivo, error: errorBusqueda } = await supabase
      .from("tickets")
      .select("id, veces")
      .eq("clave_bot", clave)
      .in("estado", ["abierto", "en_progreso"])
      .maybeSingle();

    if (errorBusqueda) {
      console.error("[ticketsRepo] buscando ticket vivo:", errorBusqueda.message);
      return;
    }

    const ahora = new Date().toISOString();

    if (vivo) {
      const { error } = await supabase
        .from("tickets")
        .update({
          veces: (vivo.veces ?? 1) + 1,
          descripcion: detalle.slice(0, 4000),
          actualizado_en: ahora,
        })
        .eq("id", vivo.id);
      if (error) console.error("[ticketsRepo] actualizando ticket:", error.message);
      return;
    }

    const { error } = await supabase.from("tickets").insert({
      titulo: tituloDe(clave, detalle),
      descripcion: detalle.slice(0, 4000),
      area: "bot",
      origen: "bot",
      prioridad: prioridadDe(clave),
      estado: "abierto",
      reportado_por: "bot",
      clave_bot: clave,
      veces: 1,
      creado_en: ahora,
      actualizado_en: ahora,
    });

    // 23505 = unique_violation: otro mensaje lo abrió en el mismo instante. No es un error real.
    if (error && (error as { code?: string }).code !== "23505") {
      console.error("[ticketsRepo] abriendo ticket:", error.message);
    }
  } catch (e) {
    console.error("[ticketsRepo] abrirTicketTecnico:", e instanceof Error ? e.message : e);
  }
}

/**
 * [2026-09-16] Ticket REPORTADO POR UNA PERSONA del equipo, desde WhatsApp, con la palabra
 * "corrige" al principio del mensaje o del audio (ver `intentarReporteDeFalla` en
 * core/pipeline/comandos.ts). Es distinto de `abrirTicketTecnico`:
 *
 *   - NO se deduplica. Cada reporte es un ticket nuevo aunque describa lo mismo que otro:
 *     quien lo cuenta ya vio algo, y juntar dos observaciones humanas en un solo contador
 *     borraría el contexto (la hora, el cliente, cómo lo vio). Para no chocar con el índice
 *     único parcial de `clave_bot`, se le pone una clave irrepetible por reporte.
 *   - Se sabe QUIÉN lo reportó: va en `reportado_por` y en la primera línea de la descripción.
 *   - Prioridad "media" por defecto: el equipo la ajusta en el panel si hace falta.
 *
 * Devuelve el id del ticket creado, o null si no se pudo (nunca lanza — el aviso al equipo lo
 * decide quien llama, mirando el null).
 */
export async function abrirTicketReportado(entrada: {
  texto: string;
  reportadoPor: string;
  canal: string;
  externalId: string;
  /** "texto" o "audio" — para dejar constancia de cómo llegó el reporte. */
  medio?: string;
}): Promise<number | null> {
  if (!supabaseConfigured) return null;

  const texto = entrada.texto.trim();
  const ahora = new Date().toISOString();
  // Título: la primera oración del reporte, recortada. Si es muy corta, el reporte entero.
  const primeraOracion = texto.split(/(?<=[.!?])\s+|\n/)[0]?.trim() || texto;
  const titulo = `Reporte del equipo: ${primeraOracion}`.slice(0, 180);
  const descripcion =
    `Reportado por ${entrada.reportadoPor} (${entrada.canal}:${entrada.externalId}) ` +
    `por ${entrada.medio ?? "texto"} el ${ahora}.\n\n${texto}`.slice(0, 4000);
  // Clave única por reporte: cumple el índice de `clave_bot` sin fusionarse con nada.
  const claveUnica = `reporte_equipo:${entrada.canal}:${entrada.externalId.replace(/\D/g, "").slice(-10)}:${Date.now()}`;

  const fila = {
    titulo,
    descripcion,
    area: "bot",
    prioridad: "media",
    estado: "abierto",
    reportado_por: entrada.reportadoPor.slice(0, 120),
    clave_bot: claveUnica,
    veces: 1,
    creado_en: ahora,
    actualizado_en: ahora,
  };

  try {
    // Primero con origen "whatsapp" (es de dónde viene de verdad). Si el panel restringe los
    // valores de `origen` con un CHECK y ese no está permitido (23514), se reintenta con "bot",
    // que es el que ya usa `abrirTicketTecnico` y se sabe que pasa.
    let { data, error } = await supabase
      .from("tickets")
      .insert({ ...fila, origen: "whatsapp" })
      .select("id")
      .single();

    if (error && (error as { code?: string }).code === "23514") {
      ({ data, error } = await supabase
        .from("tickets")
        .insert({ ...fila, origen: "bot" })
        .select("id")
        .single());
    }

    if (error) {
      console.error("[ticketsRepo] abriendo ticket reportado:", error.message);
      return null;
    }
    return (data as { id: number } | null)?.id ?? null;
  } catch (e) {
    console.error("[ticketsRepo] abrirTicketReportado:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * [2026-09-16] Ticket de HISTORIAL por una enseñanza al bot (`/aprende ...`, ver comandos.ts).
 * No es una falla pendiente: nace ya RESUELTO, porque la corrección quedó aplicada en el mismo
 * instante (se inyecta al prompt desde el mensaje siguiente). Existe para que en el panel quede
 * el rastro de todo lo que se le fue arreglando o enseñando al bot, junto con las fallas
 * reportadas — decisión de Daniel: "para tener un historial de los arreglos o enseñanzas".
 *
 * `clave_bot` lleva el id de la fila de `correcciones`, así se puede cruzar una cosa con la otra.
 * Devuelve el id del ticket, o null si no se pudo (nunca lanza: la enseñanza YA quedó guardada,
 * y un ticket que falla no puede deshacer eso ni tumbar la respuesta).
 */
export async function abrirTicketEnsenanza(entrada: {
  texto: string;
  correccionId: number;
  ensenadoPor: string;
  canal: string;
  externalId: string;
}): Promise<number | null> {
  if (!supabaseConfigured) return null;

  const texto = entrada.texto.trim();
  const ahora = new Date().toISOString();
  const fila = {
    titulo: `Enseñanza al bot (#${entrada.correccionId}): ${texto}`.slice(0, 180),
    descripcion:
      `Regla enseñada por ${entrada.ensenadoPor} (${entrada.canal}:${entrada.externalId}) el ${ahora} ` +
      `con /aprende. Corrección #${entrada.correccionId} en la tabla \`correcciones\`, activa desde el ` +
      `mensaje siguiente para todos los clientes.\n\n"${texto}"`.slice(0, 4000),
    area: "bot",
    prioridad: "media",
    reportado_por: entrada.ensenadoPor.slice(0, 120),
    clave_bot: `aprende:${entrada.correccionId}`,
    veces: 1,
    creado_en: ahora,
    actualizado_en: ahora,
  };

  // Los valores exactos que acepta el panel para `estado` y `origen` no están en este repo, así
  // que se va probando de más específico a más seguro y se cae al siguiente solo ante un CHECK
  // violado (23514). "abierto" nunca: la gracia es que este ticket no aparezca como pendiente.
  const intentos: { estado: string; origen: string }[] = [
    { estado: "resuelto", origen: "whatsapp" },
    { estado: "resuelto", origen: "bot" },
    { estado: "cerrado", origen: "bot" },
  ];

  try {
    for (const extra of intentos) {
      const { data, error } = await supabase
        .from("tickets")
        .insert({ ...fila, ...extra })
        .select("id")
        .single();
      if (!error) return (data as { id: number } | null)?.id ?? null;
      if ((error as { code?: string }).code !== "23514") {
        console.error("[ticketsRepo] abriendo ticket de enseñanza:", error.message);
        return null;
      }
    }
    console.error("[ticketsRepo] ticket de enseñanza: el panel rechazó todas las combinaciones de estado/origen.");
    return null;
  } catch (e) {
    console.error("[ticketsRepo] abrirTicketEnsenanza:", e instanceof Error ? e.message : e);
    return null;
  }
}
