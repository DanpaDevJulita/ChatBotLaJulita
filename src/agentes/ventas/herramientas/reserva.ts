import type { ToolDefinition } from "../../../core/tools/types.js";
import { buscarPlanPorNombre, precioPara, tarifaDeFecha, ETIQUETA_TARIFA } from "./planes.js";
import { registrarDatosReserva, type DatosPersona } from "../../../core/db/reservasRepo.js";
import { cargarCatalogoDomos, claseParaAgrupar, capacidadDePlan } from "./planes.js";
import { crearBloqueo, type ClaseDomoBloqueo } from "../../../core/db/bloqueosRepo.js";
import { programarLiberacion, BLOQUEO_MINUTOS } from "../../../core/queue/bloqueoQueue.js";
import { resolverCategoryId, crearBlockLobby, sumarDias } from "../../../core/integrations/lobbypms.js";
import type { ToolContext } from "../../../core/tools/types.js";

function formatMoney(n: number): string {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

interface PersonaArgs {
  nombre?: string;
  tipo_documento?: string;
  numero_documento?: string;
  celular?: string;
  correo?: string;
}

/** Qué le falta a una persona para poder registrarla. */
function faltantesDe(p: PersonaArgs | undefined, pedirCelular: boolean): string[] {
  const faltan: string[] = [];
  if (!p?.nombre?.trim()) faltan.push("el nombre completo");
  if (!p?.tipo_documento?.trim()) faltan.push("el tipo de documento (cédula, pasaporte, tarjeta de identidad...)");
  if (!p?.numero_documento?.trim()) faltan.push("el número de documento");
  if (pedirCelular && !p?.celular?.trim()) faltan.push("el número de celular");
  return faltan;
}

/**
 * [2026-09-08] Registro de los datos de la reserva. Antes el bot solo pedía nombres y cédulas y
 * eso quedaba en el chat: nadie lo pasaba a la base. Ahora quien reserva queda en `clientes`,
 * cada acompañante en `acompanantes`, y la reserva en `reservas` como pendiente de pago (sin
 * domo asignado: eso lo decide el equipo al confirmar el cupo).
 *
 * La herramienta valida antes de escribir: si falta un dato, en vez de guardar a medias devuelve
 * exactamente qué falta para que el bot lo pida. Y si algo falla en la base, el cliente nunca ve
 * el error técnico — se le dice que el equipo sigue con su caso y el detalle queda en los logs.
 */
export const registrarDatosReservaTool: ToolDefinition = {
  name: "registrar_datos_reserva",
  permitirRedaccion: true,
  description:
    "Guarda los datos para dejar la reserva registrada: quien reserva (nombre completo, tipo y número de documento, celular y correo opcional) y CADA acompañante (nombre completo, tipo y número de documento). Llamala solo cuando ya tengas el plan elegido, la fecha, cuántas personas son y los datos de todos los huéspedes. Si falta algún dato te dice cuál pedir. La reserva queda como pendiente de pago y el equipo confirma el cupo.",
  parameters: {
    type: "object",
    properties: {
      plan: { type: "string", description: "Nombre (o parte del nombre) del plan que eligió el cliente." },
      fecha: { type: "string", description: "Fecha de la estadía en formato AAAA-MM-DD." },
      festivo: { type: "boolean", description: "true si ese fin de semana es puente festivo." },
      personas: { type: "integer", description: "Cuántas personas se hospedan en total, incluyendo a quien reserva." },
      cliente: {
        type: "object",
        description: "Quien hace la reserva.",
        properties: {
          nombre: { type: "string", description: "Nombre y apellidos completos." },
          tipo_documento: { type: "string", description: "Tal como lo dijo el cliente: cédula, CC, pasaporte, tarjeta de identidad, cédula de extranjería..." },
          numero_documento: { type: "string", description: "Número del documento, solo dígitos." },
          celular: { type: "string", description: "Número de celular de contacto." },
          correo: { type: "string", description: "Correo electrónico, si lo dio (opcional)." },
        },
        required: ["nombre", "tipo_documento", "numero_documento", "celular"],
      },
      acompanantes: {
        type: "array",
        description: "Las demás personas que se hospedan. Una entrada por acompañante.",
        items: {
          type: "object",
          properties: {
            nombre: { type: "string", description: "Nombre y apellidos completos." },
            tipo_documento: { type: "string", description: "Tipo de documento del acompañante." },
            numero_documento: { type: "string", description: "Número del documento." },
            celular: { type: "string", description: "Celular, si lo dio (opcional)." },
            correo: { type: "string", description: "Correo, si lo dio (opcional)." },
          },
          required: ["nombre", "tipo_documento", "numero_documento"],
        },
      },
    },
    required: ["plan", "fecha", "personas", "cliente"],
  },
  handler: async (
    args: {
      plan?: string;
      fecha?: string;
      festivo?: boolean;
      personas?: number;
      cliente?: PersonaArgs;
      acompanantes?: PersonaArgs[];
    },
    ctx: ToolContext
  ) => {
    const acompanantes = args?.acompanantes ?? [];
    const personas = Number(args?.personas) || 0;

    // --- Validaciones antes de escribir nada ---
    const pendientes: string[] = [];

    if (!args?.plan?.trim()) pendientes.push("cuál plan quiere tomar");
    if (!/^\d{4}-\d{2}-\d{2}$/.test((args?.fecha ?? "").trim())) pendientes.push("la fecha exacta de la estadía");
    if (personas <= 0) pendientes.push("cuántas personas se hospedan");

    const faltanCliente = faltantesDe(args?.cliente, true);
    if (faltanCliente.length > 0) pendientes.push(`de quien reserva: ${faltanCliente.join(", ")}`);

    acompanantes.forEach((a, i) => {
      const faltan = faltantesDe(a, false);
      if (faltan.length > 0) pendientes.push(`del acompañante ${i + 1}${a?.nombre ? ` (${a.nombre})` : ""}: ${faltan.join(", ")}`);
    });

    // Si dijeron que son 3 y solo hay datos de 2, faltan huéspedes por registrar.
    if (personas > 0 && faltanCliente.length === 0) {
      const registrables = 1 + acompanantes.filter((a) => faltantesDe(a, false).length === 0).length;
      if (registrables < personas) {
        const cuantos = personas - registrables;
        pendientes.push(
          `los datos de ${cuantos} ${cuantos === 1 ? "acompañante más" : "acompañantes más"} (nombre completo, tipo y número de documento)`
        );
      }
    }

    if (pendientes.length > 0) {
      return {
        result: { ok: false, faltan: pendientes },
        reply_to_user:
          "Para dejar la reserva registrada me falta " +
          pendientes.join("; ") +
          ". ¿Me lo puedes compartir?",
      };
    }

    // --- Resolver el plan y el valor de esa fecha ---
    const plan = await buscarPlanPorNombre(args!.plan!);
    if (!plan || plan.id == null) {
      return {
        result: { ok: false, motivo: "plan no identificado" },
        reply_to_user:
          "Quiero asegurarme de registrar el plan correcto — ¿me confirmas el nombre del plan que quieres tomar?",
      };
    }

    const tarifa = tarifaDeFecha(args!.fecha!, args?.festivo);
    const valor = tarifa ? precioPara(plan, tarifa) : null;

    const cliente: DatosPersona = {
      nombre: args!.cliente!.nombre!.trim(),
      tipo_documento: args!.cliente!.tipo_documento!.trim(),
      numero_documento: args!.cliente!.numero_documento!.trim(),
      celular: args!.cliente!.celular?.trim() ?? null,
      correo: args!.cliente!.correo?.trim() ?? null,
    };

    const resultado = await registrarDatosReserva({
      cliente,
      acompanantes: acompanantes.map((a) => ({
        nombre: a.nombre!.trim(),
        tipo_documento: a.tipo_documento!.trim(),
        numero_documento: a.numero_documento!.trim(),
        celular: a.celular?.trim() ?? null,
        correo: a.correo?.trim() ?? null,
      })),
      plan_id: plan.id,
      fecha: args!.fecha!,
      numero_huespedes: personas,
      valor_total: valor,
    });

    if (!resultado.ok) {
      // El cliente no tiene por qué enterarse de un problema de base de datos.
      console.error(`[registrar_datos_reserva] No se pudo registrar: ${resultado.motivo}`);
      return {
        result: { ok: false, motivo: resultado.motivo },
        reply_to_user:
          "Ya tengo tus datos anotados 📝 Se los paso al equipo de La Julita para que te confirmen el cupo y te den los datos de pago.",
      };
    }

    const valorTexto = valor != null && tarifa ? `${formatMoney(valor)} ${ETIQUETA_TARIFA[tarifa]}` : "el valor que ya te confirmé";

    // [2026-09-09] Bloqueo temporal: apenas queda registrado, se marca el domo+capacidad+fecha
    // como "tomado" por 10 minutos (BLOQUEO_MINUTOS) para que el bot no le prometa este mismo
    // cupo a otro cliente mientras este confirma el pago. Si falla (Supabase caído, plan sin
    // clase reconocible) NO frena la reserva — el cliente ya quedó registrado, esto es un
    // seguro extra, no un requisito.
    let avisoBloqueo = "";
    try {
      const catDomos = await cargarCatalogoDomos();
      const claseTexto = claseParaAgrupar(plan, catDomos);
      if (claseTexto === "chalet" || claseTexto === "clasico" || claseTexto === "deluxe") {
        const clase = claseTexto as ClaseDomoBloqueo;
        const capacidadPlan = capacidadDePlan(plan, catDomos) ?? personas;
        // LobbyPMS solo tiene "clasico" en dos capacidades fijas (2 o 4) — a lo que no sea
        // chalet/deluxe (que solo existen en 2) se le redondea al bucket que le corresponde.
        const capacidad = clase === "clasico" ? (capacidadPlan <= 2 ? 2 : 4) : 2;

        // [2026-09-10] Además del candado interno de siempre, se intenta el bloqueo REAL en
        // LobbyPMS (POST /block) para que también quede visible en el calendario de los
        // vendedores, no solo adentro del bot. Es mejor esfuerzo: si la API oficial no está
        // disponible (sin token, IP no autorizada, o la categoría no se pudo resolver) se sigue
        // igual solo con el candado interno, como se hacía antes de hoy.
        let lobbyBlockId: number | null = null;
        let lobbyCategoryId: number | null = null;
        try {
          const categoryId = await resolverCategoryId(clase, capacidad, args!.fecha!, 1);
          const fechaSalida = categoryId != null ? sumarDias(args!.fecha!, 1) : null;
          if (categoryId != null && fechaSalida) {
            const block = await crearBlockLobby({
              categoryId,
              fechaEntradaISO: args!.fecha!,
              fechaSalidaISO: fechaSalida,
              minutos: BLOQUEO_MINUTOS,
              nota: `Bot WhatsApp — ${cliente.nombre} — pendiente de pago`,
            });
            if (block) {
              lobbyBlockId = block.blockId;
              lobbyCategoryId = categoryId;
            }
          }
        } catch (err) {
          console.error(
            "[registrar_datos_reserva] No se pudo bloquear el cupo real en LobbyPMS (sigo con el candado interno):",
            err
          );
        }

        const bloqueo = await crearBloqueo({
          canal: ctx.channel,
          externalId: ctx.externalId,
          planId: plan.id!,
          claseDomo: clase,
          capacidad,
          fechaEntrada: args!.fecha!,
          minutosVigencia: BLOQUEO_MINUTOS,
          clienteId: resultado.cliente_id ?? null,
          personas,
          valorTotal: valor,
          lobbyBlockId,
          lobbyCategoryId,
        });
        if (bloqueo) {
          await programarLiberacion(bloqueo.id, ctx.channel, ctx.externalId);
          avisoBloqueo =
            `\n\n⏳ Te dejo apartado este cupo por ${BLOQUEO_MINUTOS} minutos mientras confirmás el pago — ` +
            "si pasa ese tiempo sin confirmación, se libera automáticamente y podría tomarlo otro cliente.";
        }
      }
    } catch (err) {
      console.error("[registrar_datos_reserva] No se pudo crear el bloqueo temporal (no frena la reserva):", err);
    }

    // Si la base no permitió crear la reserva (domo_id obligatorio), el cliente igual quedó
    // guardado y los acompañantes quedan anotados en la conversación para el equipo. Al cliente
    // le decimos lo mismo en los dos casos: sus datos ya están y el equipo confirma el cupo.
    if (resultado.modo === "cliente_y_acompanantes") {
      console.warn(
        `[registrar_datos_reserva] Cliente #${resultado.cliente_id} y ${resultado.acompanantes_registrados} ` +
          `acompañante(s) guardados SIN reserva vinculada: ${resultado.motivo}`
      );
    }

    if (resultado.modo === "solo_cliente") {
      console.warn(
        `[registrar_datos_reserva] Registro parcial (cliente #${resultado.cliente_id}): ${resultado.motivo} ` +
          `Acompañantes que NO quedaron en la base: ${JSON.stringify(resultado.acompanantes_sin_guardar)}`
      );
    }

    const acompanantesTexto =
      resultado.modo !== "solo_cliente" && (resultado.acompanantes_registrados ?? 0) > 0
        ? `Quedan ${resultado.acompanantes_registrados} acompañante(s) anotados. `
        : acompanantes.length > 0
          ? `Anoté también los datos de ${acompanantes.length} acompañante(s). `
          : "";

    return {
      result: {
        ok: true,
        modo: resultado.modo,
        reserva_id: resultado.reserva_id,
        cliente_id: resultado.cliente_id,
        acompanantes_registrados: resultado.acompanantes_registrados,
        acompanantes_recibidos: acompanantes.length,
        plan: plan.nombre,
        fecha: args!.fecha,
        personas,
        valor_total: valor,
      },
      reply_to_user:
        `¡Listo! Ya quedaron registrados tus datos para el ${plan.nombre} el ${args!.fecha} ` +
        `para ${personas} ${personas === 1 ? "persona" : "personas"}, por ${valorTexto} (sin IVA). ` +
        acompanantesTexto +
        "El equipo de La Julita te confirma el cupo y te envía los datos de pago para dejarlo apartado con el abono del 50%. " +
        "¿Prefieres pagar con QR (llave Bre-B, sin costo) o con link de tarjeta (suma 6%)?" +
        avisoBloqueo,
    };
  },
};
