import type { Bloqueo } from "../db/bloqueosRepo.js";
import { guardarReservaLobby } from "../db/bloqueosRepo.js";
import { supabase, supabaseConfigured } from "../db/supabase.js";
import { obtenerTextoTipoDocumento } from "../db/reservasRepo.js";
import {
  apiOficialConfigurada,
  crearOActualizarClienteLobby,
  crearReservaLobby,
  liberarBlockLobby,
  sumarDias,
} from "../integrations/lobbypms.js";

/**
 * [2026-09-10] 1.2.d: el equipo eligió que el bot cree la reserva real en LobbyPMS cuando
 * confirman el pago con `/confirmar` (ver comandos.ts) — en vez de que el bot solo apague su
 * propio candado interno como hacía hasta hoy. Todo lo que hace falta ya quedó guardado en el
 * bloqueo cuando se creó (`registrar_datos_reserva` en reserva.ts): categoría de LobbyPMS,
 * fechas, personas, y el cliente ya está en Supabase.
 *
 * Mejor esfuerzo, como el resto de la integración con LobbyPMS: si algo falla acá, el pago
 * SIGUE confirmado (nunca se deshace lo que ya hizo /confirmar) y el equipo termina de crear la
 * reserva a mano en el panel de LobbyPMS. El motivo del fallo es solo para el equipo (queda en
 * la respuesta de /confirmar y en los logs) — el cliente nunca ve nada de esto.
 */

export interface ResultadoReservaLobby {
  ok: boolean;
  bookingId?: number;
  motivo?: string;
}

interface ClienteFila {
  id: number;
  nombre: string;
  numero_documento: string;
  celular: string | null;
  correo: string | null;
  tipo_documento_id: number;
}

async function obtenerClientePorId(clienteId: number): Promise<ClienteFila | null> {
  if (!supabaseConfigured) return null;
  const { data, error } = await supabase
    .from("clientes")
    .select("id, nombre, numero_documento, celular, correo, tipo_documento_id")
    .eq("id", clienteId)
    .single();
  if (error || !data) {
    console.error(`[reservaLobby] no encontré el cliente #${clienteId} en Supabase:`, error?.message);
    return null;
  }
  return data as ClienteFila;
}

export async function crearReservaRealDesdeBloqueo(bloqueo: Bloqueo): Promise<ResultadoReservaLobby> {
  if (!apiOficialConfigurada()) {
    return { ok: false, motivo: "la API oficial de LobbyPMS no está configurada (falta LOBBYPMS_API_TOKEN)" };
  }
  if (!bloqueo.lobby_category_id) {
    return {
      ok: false,
      motivo:
        "este bloqueo no tiene la categoría de LobbyPMS guardada (se creó antes de esta función, o la " +
        "API oficial no respondió en ese momento)",
    };
  }
  if (!bloqueo.cliente_id) {
    return { ok: false, motivo: "este bloqueo no quedó vinculado a un cliente en Supabase" };
  }

  const cliente = await obtenerClientePorId(bloqueo.cliente_id);
  if (!cliente) {
    return { ok: false, motivo: `no encontré los datos del cliente #${bloqueo.cliente_id} en Supabase` };
  }

  const fechaSalida = sumarDias(bloqueo.fecha_entrada, Math.max(1, bloqueo.noches ?? 1));
  if (!fechaSalida) {
    return { ok: false, motivo: `la fecha de entrada guardada no es válida: ${bloqueo.fecha_entrada}` };
  }

  const tipoDocTexto = (await obtenerTextoTipoDocumento(cliente.tipo_documento_id)) ?? "CC";

  // Se crea/actualiza el cliente en LobbyPMS ANTES de la reserva, para poder vincularla por
  // `customer_document` (más prolijo que dejar que LobbyPMS cree uno nuevo solo con el nombre).
  // Si falla, se sigue igual: `crearReservaLobby` cae a `holder_name` como respaldo.
  const clienteListo = await crearOActualizarClienteLobby({
    nombreCompleto: cliente.nombre,
    tipoDocumentoTexto: tipoDocTexto,
    numeroDocumento: cliente.numero_documento,
    celular: cliente.celular,
    correo: cliente.correo,
  });

  const anticipo = bloqueo.valor_total != null ? Math.round(bloqueo.valor_total * 0.5) : undefined;
  const canalId = process.env.LOBBYPMS_CHANNEL_ID ? Number(process.env.LOBBYPMS_CHANNEL_ID) : undefined;

  const reserva = await crearReservaLobby({
    categoryId: bloqueo.lobby_category_id,
    fechaEntradaISO: bloqueo.fecha_entrada,
    fechaSalidaISO: fechaSalida,
    totalAdultos: bloqueo.personas ?? 1,
    numeroDocumentoCliente: clienteListo ? cliente.numero_documento : undefined,
    nacionalidadCliente: "CO",
    nombreSiNuevo: clienteListo ? undefined : cliente.nombre,
    anticipo,
    nota: `Reserva creada por el bot de WhatsApp (bloqueo #${bloqueo.id}) — ${cliente.nombre}`,
    channelId: Number.isFinite(canalId) ? canalId : undefined,
  });

  if (!reserva) {
    return {
      ok: false,
      motivo: "LobbyPMS no confirmó la creación de la reserva (el detalle quedó en los logs del worker)",
    };
  }

  await guardarReservaLobby(bloqueo.id, reserva.bookingId, reserva.roomId);

  // La reserva ya ocupa el cupo — el bloqueo aparte ya no hace falta, se libera para no dejar un
  // candado fantasma en el calendario hasta que expire solo.
  if (bloqueo.lobby_block_id) {
    await liberarBlockLobby(bloqueo.lobby_block_id);
  }

  return { ok: true, bookingId: reserva.bookingId };
}
