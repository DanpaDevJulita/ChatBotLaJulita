import {
  promocionesRepo,
  plantillasCarouselRepo,
  registrarEnvioPromocion,
  type Promocion,
  type PlantillaCarousel,
} from "../db/promocionesRepo.js";
import { sendCarouselTemplate, type TarjetaCarousel } from "../../channels/whatsapp-ycloud/client.js";

/**
 * [2026-09-15] Módulo de promociones — el carrusel de WhatsApp (ver
 * REFERENCIA-CAROUSEL-WHATSAPP.md) se reserva SOLO para esto, y SOLO se dispara a mano desde el
 * panel de administración cuando el equipo lanza una campaña (decisión de Daniel, 2026-09-15) —
 * nunca automático durante una conversación normal del bot.
 *
 * Este archivo hace dos cosas separadas a propósito:
 *   1. `armarTarjetasPromociones`: valida que lo que hay cargado (promociones activas +
 *      plantilla elegida) realmente se pueda mandar, ANTES de gastar ni un solo mensaje.
 *   2. `enviarPromocionesCarousel`: manda, uno por uno, y deja registro de qué pasó.
 *
 * Separado así porque la validación es la parte que MÁS importa: WhatsApp no manda "las 4
 * tarjetas que alcancen" si la plantilla se aprobó con 5 — rechaza todo el mensaje. Es mejor que
 * el panel avise ANTES ("faltan activar 1 promoción más") que descubrirlo a mitad de una
 * campaña con la mitad de los clientes ya escritos.
 */

export interface ResultadoEnvioPromo {
  destinatario: string;
  ok: boolean;
  error?: string;
}

export interface ResultadoBroadcastPromo {
  plantilla: string;
  cantidadTarjetas: number;
  promocionesEnviadas: { id?: number; nombre: string }[];
  resultados: ResultadoEnvioPromo[];
  exitosos: number;
  fallidos: number;
}

/** Teléfono E.164 válido: "+" seguido de 8 a 15 dígitos — mismo formato que exige el adapter. */
function esTelefonoValido(id: string): boolean {
  return /^\+\d{8,15}$/.test(id);
}

/**
 * Arma las tarjetas a partir de las promociones ACTIVAS de hoy, validadas contra la plantilla
 * elegida. Lanza un error con un mensaje pensado para mostrarse tal cual en el panel (no un
 * mensaje técnico) si algo no calza.
 */
export async function armarTarjetasPromociones(nombrePlantilla: string): Promise<{
  plantilla: PlantillaCarousel;
  tarjetas: TarjetaCarousel[];
  promociones: Promocion[];
}> {
  const [plantillas, promociones] = await Promise.all([
    plantillasCarouselRepo.list(true),
    promocionesRepo.list(true),
  ]);

  const plantilla = plantillas.find((p) => p.nombre_plantilla === nombrePlantilla);
  if (!plantilla) {
    throw new Error(
      `No hay ninguna plantilla de carousel activa registrada como "${nombrePlantilla}". Revisa ` +
        `la sección "Plantillas de carousel" del panel — tiene que existir y estar aprobada por Meta.`
    );
  }

  if (promociones.length === 0) {
    throw new Error("No hay ninguna promoción activa para enviar. Activa al menos una en la tabla de promociones.");
  }

  if (promociones.length !== plantilla.cantidad_tarjetas) {
    throw new Error(
      `La plantilla "${nombrePlantilla}" se aprobó con ${plantilla.cantidad_tarjetas} tarjeta(s) ` +
        `en Meta, pero hoy hay ${promociones.length} promoción(es) activa(s). Activa o desactiva ` +
        `promociones hasta que el número calce exacto — WhatsApp rechaza el envío si no coincide.`
    );
  }

  if (plantilla.incluye_boton_url) {
    const sinLink = promociones.filter((p) => !p.boton_url);
    if (sinLink.length > 0) {
      throw new Error(
        `La plantilla "${nombrePlantilla}" necesita un link en el botón de cada tarjeta, pero a ` +
          `estas promociones les falta "URL del botón": ${sinLink.map((p) => p.nombre).join(", ")}.`
      );
    }
  }

  const tarjetas: TarjetaCarousel[] = promociones.map((p) => ({
    imagenUrl: p.imagen_url,
    precioTexto: p.texto_tarjeta,
    urlVariable: plantilla.incluye_boton_url ? p.boton_url ?? undefined : undefined,
    quickReplyPayload: p.id != null ? `promo_${p.id}` : undefined,
  }));

  return { plantilla, tarjetas, promociones };
}

/**
 * Dispara la campaña: valida, manda uno por uno (con una pausa chica entre cada uno) y deja
 * registro en `promociones_envios`. A propósito NO usa la cola (BullMQ) de mensajes entrantes —
 * es un envío puntual y manual, y el panel necesita el resultado real apenas termina.
 */
export async function enviarPromocionesCarousel(
  nombrePlantilla: string,
  destinatariosCrudos: string[]
): Promise<ResultadoBroadcastPromo> {
  const destinatarios = Array.from(new Set(destinatariosCrudos.map((d) => d.trim()).filter(Boolean)));
  if (destinatarios.length === 0) {
    throw new Error("No hay ningún destinatario para enviar (la lista llegó vacía).");
  }
  const invalidos = destinatarios.filter((d) => !esTelefonoValido(d));
  if (invalidos.length > 0) {
    throw new Error(
      `Estos números no están en formato +57XXXXXXXXXX (con el "+" y el indicativo del país): ${invalidos.join(", ")}`
    );
  }

  const { plantilla, tarjetas, promociones } = await armarTarjetasPromociones(nombrePlantilla);

  const resultados: ResultadoEnvioPromo[] = [];
  for (const destinatario of destinatarios) {
    try {
      await sendCarouselTemplate(destinatario, plantilla.nombre_plantilla, tarjetas, plantilla.idioma ?? "es");
      resultados.push({ destinatario, ok: true });
    } catch (err) {
      resultados.push({ destinatario, ok: false, error: (err as Error).message });
    }
    // Pausa chica para no disparar todo en el mismo instante — no es un límite real de YCloud
    // conocido, es solo prudencia mientras no haya necesidad de mandar campañas masivas.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const exitosos = resultados.filter((r) => r.ok).length;
  const fallidos = resultados.length - exitosos;

  await registrarEnvioPromocion({
    plantilla_nombre: plantilla.nombre_plantilla,
    promocion_ids: promociones.map((p) => p.id).filter((id): id is number => id != null),
    total_destinatarios: resultados.length,
    total_exitosos: exitosos,
    total_fallidos: fallidos,
    detalle_fallidos: resultados.filter((r) => !r.ok).map((r) => ({ destinatario: r.destinatario, error: r.error ?? "" })),
  });

  return {
    plantilla: plantilla.nombre_plantilla,
    cantidadTarjetas: tarjetas.length,
    promocionesEnviadas: promociones.map((p) => ({ id: p.id, nombre: p.nombre })),
    resultados,
    exitosos,
    fallidos,
  };
}
