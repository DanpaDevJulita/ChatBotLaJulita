/**
 * Sustitutos de las DOS únicas cosas que esta prueba no puede alcanzar desde acá:
 *   - Supabase (el transporte: la red de esta sesión lo bloquea). Los DATOS que sirve son los
 *     reales, copiados de la base — ver datos-reales.ts.
 *   - OpenRouter (el modelo). Acá se reemplaza a propósito por un modelo GUIONADO, para poder
 *     forzar el peor comportamiento posible en vez de esperar a que el modelo real lo repita.
 *
 * TODO lo demás que corre en esta prueba es el código de producción, sin tocar: runTurn.ts,
 * el orquestador, los prompts, las herramientas, el chequeo anti-alucinación y el envío.
 */
import axios from "axios";
import { supabase } from "../src/core/db/supabase.js";
import { openrouter } from "../src/core/llm/openrouter.js";
import { PLANES, DOMOS, CLASES } from "./datos-reales.js";

// --- Supabase de mentira, con datos de verdad ---------------------------------------------

type Fila = Record<string, any>;
const TABLAS: Record<string, Fila[]> = {
  planes: PLANES.map((p) => ({ ...p })),
  domos: DOMOS.map((d) => ({ ...d })),
  clase_domo: CLASES.map((c) => ({ ...c })),
  mensajes: [],
  estado_conversacion: [],
  correcciones: [],
  faq: [],
  adicionales: [],
  tipo_adicional: [],
  bloqueos_temporales: [],
  clientes: [],
  reservas: [],
  acompanantes: [],
  pagos: [],
  v_estado_cuenta: [],
  politicas: [],
  alertas_tecnicas: [],
};

/**
 * Las filas de una tabla, para sembrarlas o revisarlas desde una prueba.
 *
 * [2026-09-13] Crea la tabla si no existía (`??=`). Antes devolvía `TABLAS[tabla] ?? []`: con
 * una tabla nueva eso entregaba un arreglo SUELTO, así que la prueba sembraba datos en un
 * objeto que la base falsa nunca miraba, y el caso fallaba como si el código estuviera mal.
 * Pasó al agregar `politicas`.
 */
export function filasDe(tabla: string): Fila[] {
  return (TABLAS[tabla] ??= []);
}

export function sembrarMensajes(filas: Fila[]): void {
  TABLAS.mensajes = filas.map((f) => ({ ...f }));
}

/** Simula que la base se cae / devuelve vacío justo en medio de una cotización. */
export function simularBaseCaida(caida: boolean): void {
  TABLAS.planes = caida ? [] : PLANES.map((p) => ({ ...p }));
}

/**
 * Deja una reserva lista para cobrar, como si el cliente ya hubiera dado todos sus datos.
 * `v_estado_cuenta` es la vista de la que salen SIEMPRE los montos (total / pagado / saldo).
 */
export function sembrarReservaParaCobrar(params: {
  reservaId: number;
  plan: string;
  fecha: string;
  total: number;
  pagado?: number;
  cliente?: string;
  acompanantes?: string[];
}): void {
  const pagado = params.pagado ?? 0;
  TABLAS.v_estado_cuenta = [
    {
      reserva_id: params.reservaId,
      cliente_id: 1,
      cliente: params.cliente ?? "Daniel Pataquiva",
      documento: "10009040603",
      celular: "3212191805",
      fecha_checkin: params.fecha,
      fecha_fin_reserva: params.fecha,
      total: params.total,
      pagado,
      saldo: params.total - pagado,
      estado_pago: pagado > 0 ? "con_anticipo" : "pendiente",
      estado_reserva: "borrador",
      num_pagos: pagado > 0 ? 1 : 0,
    },
  ];
  TABLAS.reservas = [
    {
      id: params.reservaId,
      fecha_reservada: params.fecha,
      numero_huespedes: 3,
      planes: { nombre: params.plan },
    },
  ];
  TABLAS.acompanantes = (params.acompanantes ?? []).map((nombre, i) => ({
    id: i + 1,
    reserva_id: params.reservaId,
    nombre,
  }));
  TABLAS.pagos = [];
  linksPedidosABold.length = 0;
  rpcsLlamados.length = 0;
}

/**
 * [2026-09-13] Fallas de lectura a pedido, para probar el "Gateway Timeout" de Supabase que se
 * vio varias veces en producción: cuántas lecturas seguidas debe fallar cada tabla. Cada lectura
 * fallida descuenta uno, así se puede pedir "que falle una sola vez" (y el reintento la salve) o
 * "que falle siempre" (y entre a jugar el último dato bueno). Ver leerCatalogo en catalogoRepo.ts.
 */
const fallasPendientes = new Map<string, number>();

export function simularFallaDeLectura(tabla: string, veces: number, mensaje = "Gateway Timeout"): void {
  if (veces <= 0) fallasPendientes.delete(tabla);
  else fallasPendientes.set(tabla, veces);
  mensajeDeFalla = mensaje;
}
let mensajeDeFalla = "Gateway Timeout";

/** true si a esta tabla le toca fallar en esta lectura (y consume una de las fallas pedidas). */
function tocaFallar(tabla: string): boolean {
  const quedan = fallasPendientes.get(tabla) ?? 0;
  if (quedan <= 0) return false;
  fallasPendientes.set(tabla, quedan - 1);
  return true;
}

class Consulta {
  private filtros: [string, any][] = [];
  private comodines: [string, string][] = [];
  private orden: { campo: string; asc: boolean } | null = null;
  private tope: number | null = null;
  constructor(private tabla: string) {}

  select() { return this; }
  order(campo: string, opts?: { ascending?: boolean }) { this.orden = { campo, asc: opts?.ascending !== false }; return this; }
  limit(n: number) { this.tope = n; return this; }
  eq(campo: string, valor: any) { this.filtros.push([campo, valor]); return this; }
  /** ilike con comodines "%" — lo usa la búsqueda de conversación por últimos dígitos del celular. */
  ilike(campo: string, patron: string) {
    const cuerpo = String(patron).replace(/^%|%$/g, "").toLowerCase();
    this.comodines.push([campo, cuerpo]);
    return this;
  }
  neq() { return this; }
  in() { return this; }
  gte() { return this; }
  lte() { return this; }
  gt() { return this; }
  lt() { return this; }
  is() { return this; }
  /** No-op: esta base falsa no modela OR real — alcanza porque las pruebas que lo usan
   *  (bloqueosRepo.contarBloqueosActivos con `excluir`) trabajan sobre tablas vacías o ya
   *  filtradas por los .eq() anteriores. */
  or() { return this; }

  private resolver(): Fila[] {
    let filas = (TABLAS[this.tabla] ?? []).slice();
    for (const [campo, valor] of this.filtros) filas = filas.filter((f) => f[campo] === valor);
    for (const [campo, cuerpo] of this.comodines) {
      filas = filas.filter((f) => String(f[campo] ?? "").toLowerCase().includes(cuerpo));
    }
    if (this.orden) {
      const { campo, asc } = this.orden;
      filas.sort((a, b) => (a[campo] > b[campo] ? 1 : a[campo] < b[campo] ? -1 : 0) * (asc ? 1 : -1));
    }
    if (this.tope != null) filas = filas.slice(0, this.tope);
    return filas;
  }

  async maybeSingle() {
    if (tocaFallar(this.tabla)) return { data: null, error: { message: mensajeDeFalla } };
    return { data: this.resolver()[0] ?? null, error: null };
  }
  async single() { const f = this.resolver()[0]; return { data: f ?? null, error: f ? null : { message: "no rows" } }; }
  then(ok: (r: any) => any, mal?: (e: any) => any) {
    // Falla simulada de lectura (ver simularFallaDeLectura): devuelve el mismo `{data, error}`
    // que devolvería Supabase con un 504, para que el código de producción la maneje igual.
    if (tocaFallar(this.tabla)) return Promise.resolve(ok({ data: null, error: { message: mensajeDeFalla } }));
    try { return Promise.resolve(ok({ data: this.resolver(), error: null })); }
    catch (e) { return mal ? Promise.resolve(mal(e)) : Promise.reject(e); }
  }
}

/**
 * Columnas que identifican una fila para efectos de `upsert` — igual que la restricción única /
 * primary key que tiene la tabla real en Supabase. Sin esto, un `upsert` en la base falsa no
 * tenía forma de saber que dos llamadas eran "la misma fila": simplemente apilaba una fila nueva
 * cada vez (bien para `insert`, mal para `upsert`), y una prueba que hiciera dos upserts sobre la
 * MISMA clave (ej. alertar dos veces por la misma falla técnica) terminaba viendo DOS filas donde
 * el código real solo dejaría una — un caso real que encontró `e2e-alerta-tecnica.ts` (2026-09-13).
 */
const CLAVES_UPSERT: Record<string, string[]> = {
  estado_conversacion: ["canal", "external_id"],
  alertas_tecnicas: ["clave"],
};

class Escritura {
  constructor(private tabla: string, private filas: Fila[], private esUpsert = false) {}
  select() { return this; }
  eq() { return this; }
  async single() { return { data: this.filas[0] ?? null, error: null }; }
  then(ok: (r: any) => any) {
    const destino = (TABLAS[this.tabla] ??= []);
    const claves = this.esUpsert ? CLAVES_UPSERT[this.tabla] : null;
    for (const f of this.filas) {
      const existente = claves ? destino.find((d) => claves.every((c) => d[c] === f[c])) : undefined;
      if (existente) {
        Object.assign(existente, f);
      } else {
        destino.push({ ...f, created_at: f.created_at ?? new Date().toISOString() });
      }
    }
    return Promise.resolve(ok({ data: this.filas, error: null }));
  }
}

/** Lo que se le pidió a cada función de base guardada (`fn_...`), para poder revisarlo después. */
export const rpcsLlamados: { nombre: string; args: any }[] = [];
let proximoIdPago = 9000;

export function instalarSupabaseFalso(): void {
  (supabase as any).from = (tabla: string) => ({
    select: (..._a: any[]) => new Consulta(tabla),
    insert: (filas: Fila | Fila[]) => new Escritura(tabla, Array.isArray(filas) ? filas : [filas]),
    upsert: (filas: Fila | Fila[]) => new Escritura(tabla, Array.isArray(filas) ? filas : [filas], true),
    update: (cambios: Fila) => {
      // Soporta la cadena completa que usa el código real:
      //   .update({...}).eq(a,1).eq(b,"x").select().single()
      // Los filtros se acumulan y recién se aplican al final (al await o al .single()), igual
      // que hace PostgREST — si se aplicaran en cada .eq() se actualizarían filas de más.
      const filtros: [string, any][] = [];
      const aplicar = (): Fila[] => {
        const tocadas = (TABLAS[tabla] ?? []).filter((f) => filtros.every(([c, v]) => f[c] === v));
        for (const f of tocadas) Object.assign(f, cambios);
        return tocadas;
      };
      const cadena: any = {
        eq(campo: string, valor: any) { filtros.push([campo, valor]); return cadena; },
        select() { return cadena; },
        async single() {
          const tocadas = aplicar();
          return tocadas.length
            ? { data: tocadas[0], error: null }
            : { data: null, error: { message: "no rows" } };
        },
        then(ok: any) { const tocadas = aplicar(); return Promise.resolve(ok({ data: tocadas, error: null })); },
      };
      return cadena;
    },
    delete: () => ({ eq: async () => ({ data: null, error: null }) }),
  });

  (supabase as any).rpc = async (nombre: string, args: any) => {
    rpcsLlamados.push({ nombre, args });
    if (nombre === "fn_crear_pago_pendiente") {
      const id = proximoIdPago++;
      (TABLAS.pagos ??= []).push({
        id,
        reserva_id: args.p_reserva_id,
        tipo: args.p_tipo,
        valor: args.p_valor,
        referencia: args.p_referencia,
        estado: "pendiente",
        payment_link: null,
        link_url: null,
      });
      return { data: id, error: null };
    }
    if (nombre === "fn_registrar_pago_aprobado") {
      // Simula fn_registrar_pago_aprobado: marca el pago como pagado y recalcula el saldo de la
      // reserva, igual que la función real. Es idempotente: si ya estaba pagado, lo dice.
      const pago = (TABLAS.pagos ?? []).find((p) => p.referencia === args.p_referencia);
      if (!pago) return { data: [{ o_ok: false, o_motivo: "no existe un pago con referencia " + args.p_referencia }], error: null };

      const yaEstaba = pago.estado === "pagado";
      if (!yaEstaba) {
        pago.estado = "pagado";
        pago.bold_payment_id = args.p_bold_payment_id;
        pago.fecha_pago = new Date().toISOString();
      }

      const cuenta = (TABLAS.v_estado_cuenta ?? []).find((v) => v.reserva_id === pago.reserva_id);
      if (cuenta && !yaEstaba) {
        cuenta.pagado = Number(cuenta.pagado ?? 0) + Number(args.p_valor ?? pago.valor ?? 0);
        cuenta.saldo = Number(cuenta.total ?? 0) - Number(cuenta.pagado);
        cuenta.estado_pago = cuenta.saldo <= 0 ? "pagada_total" : "con_anticipo";
      }

      return {
        data: [{
          o_ok: true,
          o_ya_procesado: yaEstaba,
          o_id_pago: pago.id,
          o_reserva_id: pago.reserva_id,
          o_total_reserva: cuenta?.total ?? null,
          o_total_pagado: cuenta?.pagado ?? null,
          o_saldo_pendiente: cuenta?.saldo ?? null,
          o_estado_pago: cuenta?.estado_pago ?? null,
          o_estado_reserva: cuenta?.estado_reserva ?? null,
        }],
        error: null,
      };
    }
    return { data: null, error: { message: `rpc "${nombre}" no simulada en la prueba` } };
  };
}

// --- Bold de mentira: no sale a la red, pero guarda EXACTAMENTE lo que se le pidió ----------

export const linksPedidosABold: { body: any }[] = [];
export const consultasABold: string[] = [];

/** Qué va a contestar Bold cuando le pregunten por el estado de un link. */
let estadoQueDevuelveBold: { status: string; transaction_id?: string; total?: number; reference?: string } | null = {
  status: "ACTIVE",
};
export function boldResponderaEstado(estado: typeof estadoQueDevuelveBold): void {
  estadoQueDevuelveBold = estado;
}

export function instalarBoldFalso(): void {
  // boldClient hace `axios.create(...)` la primera vez que necesita el cliente y lo guarda en
  // una variable del módulo; por eso se intercepta `create`, antes de esa primera llamada.
  (axios as any).create = () => ({
    post: async (_ruta: string, body: any) => {
      linksPedidosABold.push({ body });
      const ref = body?.reference ?? "sin-ref";
      return { data: { payload: { payment_link: `LNK_${ref}`, url: `https://checkout.bold.co/payment/LNK_${ref}` } } };
    },
    get: async (ruta: string) => {
      consultasABold.push(ruta);
      if (!estadoQueDevuelveBold) {
        // Simula que Bold no responde (red caída, llave mala): axios lanza.
        const err: any = new Error("Request failed with status code 500");
        err.response = { status: 500, data: { message: "algo salió mal del lado de Bold" } };
        throw err;
      }
      return { data: { payload: estadoQueDevuelveBold } };
    },
  });
}

// --- LobbyPMS de mentira: ni bloqueos reales ni consultas de disponibilidad salen a la red ---

/**
 * Controla lo que "responde" `GET /available-rooms` para el DOMO FAMILIAR (clase "clasico",
 * capacidad 4 — la que usan las pruebas de cupo). `null` simula que la API no contestó (timeout,
 * IP no autorizada, 5xx): así se puede probar el camino de reintentos sin depender de la red real.
 *
 * Es un ARREGLO: cada llamada a GET /available-rooms consume la primera entrada y la saca de la
 * lista (para poder simular "las dos primeras veces falla, la tercera contesta"); si se vacía, se
 * repite la última entrada.
 */
let lobbyDisponibilidadEnCola: (number | null)[] = [5];
let lobbyBlockOk = true;
export const consultasDisponibilidadLobby: number[] = [];
export const bloqueosCreadosLobby: any[] = [];

/**
 * [2026-09-14] Reservas REALES creadas en LobbyPMS (POST /bookings) y bloqueos liberados
 * (DELETE /block/:id). Se agregaron para poder probar, sin un pago real, el agujero que encontró
 * Daniel el 13/09: el bot confirmaba la reserva y en LobbyPMS no quedaba nada creado.
 */
export const reservasCreadasLobby: any[] = [];
export const blocksLiberadosLobby: number[] = [];
let lobbyBookingOk = true;

/** Simula que LobbyPMS NO puede crear la reserva (para probar el aviso al equipo). */
export function lobbyResponderaBooking(ok: boolean): void {
  lobbyBookingOk = ok;
}

/** `[5]` = siempre hay 5 libres. `[null, null, 4]` = falla dos veces y a la tercera dice 4 libres. */
export function lobbyResponderaDisponibilidad(secuencia: (number | null)[]): void {
  lobbyDisponibilidadEnCola = [...secuencia];
}

/**
 * [2026-09-17] Inventario completo por categoría, para las pruebas de GRUPOS (varios domos).
 * Por defecto (null) el falso solo devuelve "DOMO FAMILIAR" con la cantidad de la secuencia de
 * arriba. Con esto se simula el hotel entero: familiares, romantic, chalet y deluxe.
 * Ej.: [{ name: "DOMO FAMILIAR", available: 2 }, { name: "DOMO ROMANTIC", available: 2 }, ...]
 */
let lobbyCategoriasFijas: { name: string; available: number }[] | null = null;
export function lobbyResponderaCategorias(categorias: { name: string; available: number }[] | null): void {
  lobbyCategoriasFijas = categorias;
}

/** Si `POST /block` (volver a tomar el cupo) debe funcionar o fallar. */
export function lobbyResponderaBlock(ok: boolean): void {
  lobbyBlockOk = ok;
}

export function instalarLobbyFalso(): void {
  lobbyDisponibilidadEnCola = [5];
  lobbyCategoriasFijas = null;
  lobbyBlockOk = true;
  lobbyBookingOk = true;
  consultasDisponibilidadLobby.length = 0;
  bloqueosCreadosLobby.length = 0;
  reservasCreadasLobby.length = 0;
  blocksLiberadosLobby.length = 0;

  (axios as any).get = async (url: string, config: any) => {
    if (String(url).includes("/available-rooms")) {
      const siguiente = lobbyDisponibilidadEnCola.length > 1
        ? lobbyDisponibilidadEnCola.shift()!
        : lobbyDisponibilidadEnCola[0];
      consultasDisponibilidadLobby.push(siguiente as number);
      if (siguiente === null) {
        const err: any = new Error("Request failed with status code 403");
        err.response = { status: 403, data: { message: "ip not allowed" } };
        throw err;
      }
      const fecha = config?.params?.start_date ?? "2026-09-15";
      if (lobbyCategoriasFijas) {
        return {
          data: [{
            date: fecha,
            categories: lobbyCategoriasFijas.map((c, i) => ({ category_id: 30 + i, name: c.name, available_rooms: c.available })),
          }],
        };
      }
      return {
        data: [{ date: fecha, categories: [{ category_id: 33, name: "DOMO FAMILIAR", available_rooms: siguiente }] }],
      };
    }
    throw new Error(`[lobbyFalso] GET no simulado en la prueba: ${url}`);
  };

  (axios as any).post = async (url: string, body: any) => {
    if (String(url).includes("/block")) {
      bloqueosCreadosLobby.push(body);
      if (!lobbyBlockOk) {
        const err: any = new Error("Request failed with status code 400");
        err.response = { status: 400, data: { message: "no se pudo bloquear" } };
        throw err;
      }
      return { data: { blocked_ids: [9999] } };
    }
    if (String(url).includes("load-rooms")) {
      // Motor público (respaldo): en las pruebas nunca hace falta que lo use de verdad — cuando
      // la API oficial "falla" (ver arriba), esto solo tiene que devolver "nada", no explotar.
      return { data: { roomCategories: {}, roomNoAvailable: {} } };
    }
    // [2026-09-14] Cliente en LobbyPMS (se crea/actualiza antes de la reserva).
    if (String(url).includes("/customer/")) {
      return { data: { ok: true } };
    }
    // [2026-09-14] La reserva REAL. Lo que antes NUNCA se llamaba por los caminos automáticos.
    if (String(url).includes("/bookings")) {
      reservasCreadasLobby.push(body);
      if (!lobbyBookingOk) {
        const err: any = new Error("Request failed with status code 400");
        err.response = { status: 400, data: { message: "no se pudo crear la reserva" } };
        throw err;
      }
      return { data: { data: [{ idBooking: 55501, idRoom: 12 }] } };
    }
    throw new Error(`[lobbyFalso] POST no simulado en la prueba: ${url}`);
  };

  (axios as any).delete = async (url: string) => {
    const m = String(url).match(/\/block\/(\d+)/);
    if (m) blocksLiberadosLobby.push(Number(m[1]));
    return { data: { ok: true } };
  };
}

// --- Modelo guionado ----------------------------------------------------------------------

export interface LlamadaModelo {
  tools: string[];
  toolChoice: string | null;
  mensajes: any[];
}

/** Lo que un guion puede devolver en un hop: texto libre, o una llamada a herramienta. */
export type Respuesta =
  | { texto: string }
  | { herramienta: string; args: Record<string, unknown> };

export type Guion = (llamada: LlamadaModelo, hop: number) => Respuesta;

let guionActual: Guion | null = null;
let hopsDelAgente = 0;
export const registroDelModelo: string[] = [];

export function usarGuion(g: Guion): void {
  guionActual = g;
  hopsDelAgente = 0;
  registroDelModelo.length = 0;
}

function respuestaComoCompletion(r: Respuesta) {
  if ("texto" in r) {
    return { choices: [{ message: { role: "assistant", content: r.texto, tool_calls: undefined } }] };
  }
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: `call_${Math.random().toString(36).slice(2, 9)}`, type: "function", function: { name: r.herramienta, arguments: JSON.stringify(r.args) } },
          ],
        },
      },
    ],
  };
}

/**
 * [2026-09-14] A qué agente enruta el orquestador falso. Cada prueba elige el que necesita
 * ejercitar: las de cobro van a "pagos", las de tomar datos a "reservas", las de catálogo a
 * "informacion". Antes esto era fijo, cuando un solo agente atendía los tres temas.
 */
let agenteDeRuteo = "reservas";

export function enrutarSiempreA(agente: "informacion" | "reservas" | "pagos" | "postventa" | "humano"): void {
  agenteDeRuteo = agente;
}

export function instalarModeloFalso(): void {
  (openrouter as any).chat = {
    completions: {
      create: async (params: any) => {
        const tools: string[] = (params.tools ?? []).map((t: any) => t.function?.name).filter(Boolean);
        const toolChoice = params.tool_choice?.function?.name ?? null;

        // El orquestador falso: manda siempre al mismo agente (ver enrutarSiempreA).
        //
        // [2026-09-14] Antes iba fijo a "reservas", que en ese momento lo atendía el agente
        // `ventas` — el único que existía, y que tenía TODAS las herramientas (catálogo, reserva
        // y pago). Con los bots ya separados eso dejó de servir: `reservas` no tiene
        // `enviar_datos_pago` ni `verificar_pago` (son del bot de `pagos`), así que las pruebas
        // de pago se caían con "Herramienta desconocida" — no por un error del código, sino
        // porque el arnés enrutaba al bot equivocado para lo que la prueba quería ejercitar.
        if (tools.includes("enrutar")) {
          registroDelModelo.push(`orquestador -> ${agenteDeRuteo}`);
          return respuestaComoCompletion({ herramienta: "enrutar", args: { agente: agenteDeRuteo, motivo: "prueba" } });
        }

        hopsDelAgente++;
        const r = guionActual!({ tools, toolChoice, mensajes: params.messages }, hopsDelAgente);
        registroDelModelo.push(
          "hop " + hopsDelAgente + (toolChoice ? ` [tool_choice FORZADO: ${toolChoice}]` : "") + " -> " +
            ("texto" in r ? `TEXTO LIBRE: ${r.texto.replace(/\s+/g, " ").slice(0, 90)}...` : `llama ${r.herramienta}(${JSON.stringify(r.args)})`)
        );
        return respuestaComoCompletion(r);
      },
    },
  };
}

// --- Canal de mentira: guarda lo que el bot le habría mandado al cliente -------------------

export const enviados: string[] = [];
export const adaptadorFalso = {
  name: "prueba",
  async send(msg: { to: string; text?: string }) {
    enviados.push(msg.text ?? "");
  },
};
