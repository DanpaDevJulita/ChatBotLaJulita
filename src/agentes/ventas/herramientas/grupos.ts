/**
 * [2026-09-17] Grupos que NO caben en un solo domo: se arman con VARIOS domos.
 *
 * Pedido de Daniel (17/09), después de ver esta conversación real:
 *   Cliente: 15 personas para el 21.
 *   Bot:     "para 15 personas no tengo esa información a la mano... ¿quieres que le pase tu
 *             consulta al equipo?"
 * Y su pregunta fue la correcta: "¿por qué lo escala si tiene domos familiares y de pareja?".
 * La respuesta es que la herramienta devolvía los planes de a uno y nunca sumaba nada, y el
 * modelo tiene PROHIBIDO calcular totales por su cuenta (verificación de cifras en runTurn.ts).
 * Este módulo hace la suma que faltaba, del lado de la herramienta, para que el mensaje salga
 * con la combinación y el total ya armados y el modelo solo tenga que repetirlo tal cual.
 *
 * Regla de reparto (definida por Daniel el 17/09): PRIMERO se llenan los domos familiares,
 * DESPUÉS lo que sobra va a domos de pareja. Un domo familiar admite máximo 3 adultos, o
 * 2 adultos + 2 niños (nunca 4 adultos). Un domo de pareja, 2 personas. Ningún domo puede
 * quedar solo con niños.
 *
 * Qué se considera "familiar" y "pareja": lo dice la capacidad de la unidad, no el nombre.
 * En LobbyPMS el DOMO FAMILIAR es el clásico de capacidad 4; DOMO ROMANTIC, CHALET y DOMO
 * DELUXE son de capacidad 2 (ver CATEGORIAS_LOBBY en core/integrations/lobbypms.ts). En la
 * tabla `domos` del panel es `capacidad_max`.
 */

import type { Plan } from "../../../core/db/catalogoRepo.js";
import type { DisponibilidadCategoria } from "../../../core/integrations/lobbypms.js";
import type { ToolResult } from "../../../core/tools/types.js";
import { fechaCorta } from "../../../core/lib/fechas.js";
import {
  type CatalogoDomos,
  type Tarifa,
  type Nivel,
  type TipoPlan,
  ETIQUETA_TARIFA,
  capacidadDePlan,
  segmentoDePlan,
  sinTildes,
  tipoDePlan,
  nivelDePlan,
  precioPara,
  precioReferencia,
  formatMoney,
  textoPersonas,
  limpiar,
} from "./planes.js";

export const MAX_ADULTOS_POR_DOMO = 3;
export const MAX_PERSONAS_POR_DOMO = 4;

/** La capacidad REAL de un domo: 3 adultos, o 2 adultos y 2 niños. Nunca 4 adultos. */
export function cabeEnUnDomo(adultos: number, ninos: number): boolean {
  const total = adultos + ninos;
  if (total <= 0) return true; // no hay nada que repartir
  if (adultos > MAX_ADULTOS_POR_DOMO || total > MAX_PERSONAS_POR_DOMO) return false;
  return total < MAX_PERSONAS_POR_DOMO || adultos <= 2;
}

/**
 * ¿Hay que armarlo en varios domos? Si el cliente solo dijo "somos 4" (sin adultos/niños), se
 * sigue tratando como la familia clásica de 2 adultos y 2 niños — el flujo normal le pregunta
 * las edades. Solo con 5 o más, o cuando SÍ dijo cuántos adultos son y no caben, es grupo.
 */
export function esGrupo(reparto: Reparto): boolean {
  const total = reparto.adultos + reparto.ninos;
  if (reparto.asumidoTodosAdultos) return total > MAX_PERSONAS_POR_DOMO;
  return !cabeEnUnDomo(reparto.adultos, reparto.ninos);
}

export interface Reparto {
  adultos: number;
  ninos: number;
  /** true cuando el cliente solo dijo "somos N" y contamos a todos como adultos. */
  asumidoTodosAdultos: boolean;
}

/**
 * Cuántos adultos y niños hay, a partir de lo que el modelo alcanzó a sacarle al cliente.
 * Si solo dio el total, se asumen todos adultos (es el reparto más exigente en domos, así
 * la propuesta nunca queda corta) y se le pregunta por los niños en el mismo mensaje.
 */
export function repartoDeclarado(args: { personas?: number; adultos?: number; ninos?: number }): Reparto {
  const personas = Math.max(0, Math.floor(Number(args?.personas) || 0));
  const ninosDados = args?.ninos != null ? Math.max(0, Math.floor(Number(args.ninos) || 0)) : null;
  const adultosDados = args?.adultos != null ? Math.max(0, Math.floor(Number(args.adultos) || 0)) : null;

  if (adultosDados != null && ninosDados != null) {
    return { adultos: adultosDados, ninos: ninosDados, asumidoTodosAdultos: false };
  }
  if (adultosDados != null) {
    // Dijo adultos; los niños son lo que falta para el total (si dio total).
    const ninos = personas > adultosDados ? personas - adultosDados : 0;
    return { adultos: adultosDados, ninos, asumidoTodosAdultos: false };
  }
  if (ninosDados != null) {
    const adultos = personas > ninosDados ? personas - ninosDados : 0;
    return { adultos, ninos: ninosDados, asumidoTodosAdultos: false };
  }
  return { adultos: personas, ninos: 0, asumidoTodosAdultos: personas > 0 };
}

export interface UnidadesLibres {
  familiares: number;
  /** Unidades de pareja por clase (clasico / chalet / deluxe / otros). */
  parejasPorClase: Map<string, number>;
  parejas: number;
  /** De dónde salió el dato: cupo real del motor de reservas, o el inventario del panel. */
  origen: "lobby" | "catalogo" | "ninguno";
}

/**
 * Cuántas unidades hay para repartir. Con `disponibilidad` (LobbyPMS, ya descontados los
 * bloqueos de otras conversaciones) es cupo REAL de esa fecha; sin ella, es el inventario
 * físico del panel (tabla `domos`) — sirve para armar la propuesta, pero el cupo queda por
 * confirmar.
 */
export function unidadesLibres(disponibilidad: DisponibilidadCategoria[] | null, cat: CatalogoDomos): UnidadesLibres {
  const parejasPorClase = new Map<string, number>();
  let familiares = 0;

  if (disponibilidad && disponibilidad.length > 0) {
    for (const d of disponibilidad) {
      if (d.capacidad >= 3) familiares += Math.max(0, d.disponibles);
      else parejasPorClase.set(d.clase, (parejasPorClase.get(d.clase) ?? 0) + Math.max(0, d.disponibles));
    }
    const parejas = [...parejasPorClase.values()].reduce((a, b) => a + b, 0);
    return { familiares, parejasPorClase, parejas, origen: "lobby" };
  }

  if (cat.capacidadDeDomo.size > 0) {
    for (const [id, capacidad] of cat.capacidadDeDomo) {
      if (capacidad >= 3) familiares += 1;
      else {
        const clase = cat.claseDeDomo.get(id) ?? "otros";
        parejasPorClase.set(clase, (parejasPorClase.get(clase) ?? 0) + 1);
      }
    }
    const parejas = [...parejasPorClase.values()].reduce((a, b) => a + b, 0);
    return { familiares, parejasPorClase, parejas, origen: "catalogo" };
  }

  return { familiares: 0, parejasPorClase, parejas: 0, origen: "ninguno" };
}

export interface DomoArmado {
  tipo: "familiar" | "pareja";
  adultos: number;
  ninos: number;
}

export interface ResultadoReparto {
  domos: DomoArmado[];
  /** Personas que NO alcanzaron a acomodarse por falta de unidades. 0 = cupieron todos. */
  sinAcomodar: number;
  /** true si el reparto exigiría dejar niños en un domo sin ningún adulto. */
  ninosSinAdulto: boolean;
}

/**
 * El reparto en sí: familiares primero, parejas después.
 *
 *  - Cada familiar se llena con 2 adultos + hasta 2 niños; si no hay 2 niños para completar,
 *    entra un tercer adulto (3 adultos, o 2 adultos + 1 niño). Así ningún familiar queda con
 *    4 adultos, que no caben.
 *  - Cuando lo que queda son 2 personas o menos y hay un domo de pareja libre, se usa el de
 *    pareja en vez de gastar un familiar en dos personas.
 *  - Los domos de pareja se llenan de a 2 (el último puede quedar con 1).
 */
export function repartirEnDomos(reparto: Reparto, libres: UnidadesLibres): ResultadoReparto {
  let A = reparto.adultos;
  let N = reparto.ninos;
  const domos: DomoArmado[] = [];
  let ninosSinAdulto = false;

  let familiaresQuedan = libres.familiares;
  let parejasQuedan = libres.parejas;

  while (A + N > 0 && familiaresQuedan > 0) {
    if (A + N <= 2 && parejasQuedan > 0) break; // lo que queda cabe en un domo de pareja
    let a = Math.min(2, A);
    let n = Math.min(2, N);
    while (a + n < MAX_ADULTOS_POR_DOMO && A - a > 0) a++;
    if (a === 0) {
      ninosSinAdulto = true;
      break;
    }
    domos.push({ tipo: "familiar", adultos: a, ninos: n });
    A -= a;
    N -= n;
    familiaresQuedan--;
  }

  while (A + N > 0 && parejasQuedan > 0 && !ninosSinAdulto) {
    const a = Math.min(2, A);
    const n = Math.min(2 - a, N);
    if (a === 0) {
      ninosSinAdulto = true;
      break;
    }
    domos.push({ tipo: "pareja", adultos: a, ninos: n });
    A -= a;
    N -= n;
    parejasQuedan--;
  }

  return { domos, sinAcomodar: A + N, ninosSinAdulto };
}

// ---- Elegir con qué plan se cobra cada domo --------------------------------------------------

interface PlanCotizado {
  plan: Plan;
  precio: number;
}

function precioDe(p: Plan, tarifa: Tarifa | null): number | null {
  return (tarifa ? precioPara(p, tarifa) : null) ?? precioReferencia(p);
}

/**
 * El plan familiar que cobra un domo con `ocupacion` personas: el que diga exactamente ese
 * número en el nombre ("PLAN FAMILIAR 3 PERSONAS"), si no el más chico que alcance, si no
 * cualquier familiar con precio.
 */
function planFamiliarPara(ocupacion: number, familiares: Plan[], cat: CatalogoDomos, tarifa: Tarifa | null): PlanCotizado | null {
  const conPrecio = familiares
    .map((p) => ({ plan: p, precio: precioDe(p, tarifa), cap: capacidadDePlan(p, cat) }))
    .filter((x): x is { plan: Plan; precio: number; cap: number | null } => x.precio != null);
  if (conPrecio.length === 0) return null;
  const exacto = conPrecio.find((x) => x.cap === ocupacion);
  if (exacto) return { plan: exacto.plan, precio: exacto.precio };
  const alcanzan = conPrecio.filter((x) => x.cap != null && x.cap >= ocupacion).sort((a, b) => a.cap! - b.cap! || a.precio - b.precio);
  if (alcanzan.length > 0) return { plan: alcanzan[0].plan, precio: alcanzan[0].precio };
  conPrecio.sort((a, b) => a.precio - b.precio);
  return { plan: conPrecio[0].plan, precio: conPrecio[0].precio };
}

/**
 * Clases de domo que el plan NOMBRA en su texto ("domo clásico o chalet", "La Julita Deluxe").
 * Para los grupos NO se usa `planes.domos_id`: en la base casi todos los planes apuntan al
 * domo 1 como relleno, y con eso ningún plan de pareja "servía" en chalet ni deluxe y se
 * quedaban unidades libres sin cotizar. Si el plan no nombra ninguna clase, sirve en todas.
 */
function clasesNombradas(p: Plan): string[] {
  const texto = sinTildes(`${p.nombre ?? ""} ${p.descripcion ?? ""}`);
  return ["chalet", "clasico", "deluxe"].filter((c) => texto.includes(c));
}

interface GrupoPareja {
  plan: PlanCotizado;
  cantidad: number;
}

/**
 * Con qué plan se cobra cada domo de pareja. Se recorren las clases de domo con unidades libres
 * (clásico/romantic, chalet, deluxe) y para cada una se toma el plan de pareja MÁS ECONÓMICO que
 * sirva en esa clase (respetando el nivel que pidió el cliente, si lo hay); un plan que no
 * nombra clase sirve en cualquiera. Se llenan primero las clases cuyo plan es más barato. Si al
 * final quedan domos sin plan (una clase para la que no hay plan cargado), se reportan como
 * `sinPlan` y esas personas quedan por acomodar.
 *
 * Sin dato de inventario por clase (origen "ninguno") se usa un solo plan para todos.
 */
function asignarParejas(
  cuantos: number,
  parejas: Plan[],
  _cat: CatalogoDomos,
  tarifa: Tarifa | null,
  libres: UnidadesLibres,
  nivel?: Nivel
): { grupos: GrupoPareja[]; sinPlan: number } {
  const cotizados = parejas
    .map((p) => ({ plan: p, precio: precioDe(p, tarifa) }))
    .filter((x): x is PlanCotizado => x.precio != null)
    // Primero los del nivel pedido, y dentro de cada bloque el más económico.
    .sort((a, b) => {
      const na = nivel && nivelDePlan(a.plan) === nivel ? 0 : 1;
      const nb = nivel && nivelDePlan(b.plan) === nivel ? 0 : 1;
      return na - nb || a.precio - b.precio;
    });
  if (cotizados.length === 0 || cuantos <= 0) return { grupos: [], sinPlan: cuantos };

  const grupos = new Map<Plan, GrupoPareja>();
  const sumar = (c: PlanCotizado, n: number) => {
    const g = grupos.get(c.plan);
    if (g) g.cantidad += n;
    else grupos.set(c.plan, { plan: c, cantidad: n });
  };

  if (libres.origen === "ninguno") {
    sumar(cotizados[0], cuantos);
    return { grupos: [...grupos.values()], sinPlan: 0 };
  }

  // Mejor plan por clase de domo con unidades.
  const porClase: { clase: string; unidades: number; plan: PlanCotizado }[] = [];
  for (const [clase, unidades] of libres.parejasPorClase) {
    if (unidades <= 0) continue;
    const plan = cotizados.find((c) => {
      const clases = clasesNombradas(c.plan);
      return clases.length === 0 || clases.includes(clase);
    });
    if (plan) porClase.push({ clase, unidades, plan });
  }
  porClase.sort((a, b) => a.plan.precio - b.plan.precio);

  let quedan = cuantos;
  for (const x of porClase) {
    if (quedan <= 0) break;
    const n = Math.min(x.unidades, quedan);
    sumar(x.plan, n);
    quedan -= n;
  }
  return { grupos: [...grupos.values()], sinPlan: quedan };
}

// ---- El mensaje -------------------------------------------------------------------------------

function textoOcupacion(d: DomoArmado): string {
  const partes: string[] = [];
  if (d.adultos > 0) partes.push(`${d.adultos} ${d.adultos === 1 ? "adulto" : "adultos"}`);
  if (d.ninos > 0) partes.push(`${d.ninos} ${d.ninos === 1 ? "niño" : "niños"}`);
  return partes.join(" y ");
}

export interface EntradaGrupo {
  planes: Plan[];
  cat: CatalogoDomos;
  tarifa: Tarifa | null;
  fecha?: string;
  disponibilidad: DisponibilidadCategoria[] | null;
  reparto: Reparto;
  nivel?: Nivel;
  tipo?: TipoPlan;
}

/**
 * Arma la propuesta completa para un grupo que no cabe en un domo. Devuelve el ToolResult
 * listo: `reply_to_user` se manda TAL CUAL (forzarTextoLiteral) porque trae cifras sumadas que
 * el modelo no puede recalcular, y `result` lleva los mismos números por si hace falta.
 */
export function armarPropuestaGrupo(e: EntradaGrupo): ToolResult {
  const total = e.reparto.adultos + e.reparto.ninos;
  const tipo: TipoPlan = e.tipo && e.tipo !== "pasadia" ? e.tipo : "una_noche";
  const libres = unidadesLibres(e.disponibilidad, e.cat);

  const familiares = e.planes.filter((p) => segmentoDePlan(p) === "familia" && tipoDePlan(p) === tipo);
  const parejas = e.planes.filter((p) => segmentoDePlan(p) === "pareja" && tipoDePlan(p) === tipo);

  const quien =
    e.reparto.asumidoTodosAdultos || e.reparto.ninos === 0
      ? textoPersonas(total)
      : `${textoPersonas(total)} (${textoOcupacion({ tipo: "familiar", adultos: e.reparto.adultos, ninos: e.reparto.ninos })})`;
  const cuando = e.fecha ? `, el ${fechaCorta(e.fecha).replace(",", "")},` : "";

  const derivar = (motivo: string, extra: Record<string, unknown> = {}): ToolResult => ({
    result: { modo: "grupo", personas: total, alcanza: false, motivo, ...extra },
    reply_to_user:
      `Para ${quien}${cuando} necesito armarlo con varios domos y en este momento no me alcanza la información para cotizarlo bien — ` +
      "déjame pasarle el caso al equipo de La Julita para que te lo armen y te confirmen el cupo.",
    forzarTextoLiteral: true,
  });

  if (libres.origen === "ninguno") return derivar("sin_inventario");
  if (familiares.length === 0 && parejas.length === 0) return derivar("sin_planes");

  const rep = repartirEnDomos(e.reparto, libres);
  if (rep.ninosSinAdulto) {
    return {
      result: { modo: "grupo", personas: total, alcanza: false, motivo: "ninos_sin_adulto", adultos: e.reparto.adultos, ninos: e.reparto.ninos },
      reply_to_user:
        `Para ${quien} no me da el reparto: con ${e.reparto.adultos} ${e.reparto.adultos === 1 ? "adulto" : "adultos"} y ${e.reparto.ninos} niños ` +
        "algún domo quedaría solo con niños, y eso no se puede. ¿Me confirmas cuántos adultos van?",
      forzarTextoLiteral: true,
    };
  }

  // Cobro por domo: familiares por ocupación, parejas con un solo plan para todos.
  const lineas: string[] = [];
  const resumenDomos: { plan: string; cantidad: number; precio_unitario: number; ocupacion: string }[] = [];
  let totalPesos = 0;
  let faltaPrecio = false;

  const familiaresArmados = rep.domos.filter((d) => d.tipo === "familiar");
  const grupos = new Map<string, { plan: PlanCotizado; ocupacion: string; cantidad: number }>();
  for (const d of familiaresArmados) {
    const ocupacion = d.adultos + d.ninos;
    const cot = planFamiliarPara(ocupacion, familiares, e.cat, e.tarifa);
    if (!cot) {
      faltaPrecio = true;
      continue;
    }
    const clave = `${cot.plan.id ?? cot.plan.nombre}|${textoOcupacion(d)}`;
    const g = grupos.get(clave);
    if (g) g.cantidad++;
    else grupos.set(clave, { plan: cot, ocupacion: textoOcupacion(d), cantidad: 1 });
  }
  for (const g of grupos.values()) {
    lineas.push(
      `🏕️ ${g.cantidad} × ${limpiar(g.plan.plan.nombre)} (${g.ocupacion} en cada uno) — ${formatMoney(g.plan.precio)} c/u`
    );
    resumenDomos.push({ plan: g.plan.plan.nombre, cantidad: g.cantidad, precio_unitario: g.plan.precio, ocupacion: g.ocupacion });
    totalPesos += g.plan.precio * g.cantidad;
  }

  const parejasArmadas = rep.domos.filter((d) => d.tipo === "pareja");
  let personasSinPlanPareja = 0;
  if (parejasArmadas.length > 0) {
    const asignacion = asignarParejas(parejasArmadas.length, parejas, e.cat, e.tarifa, libres, e.nivel);
    const hayParejasConPrecio = parejas.some((p) => precioDe(p, e.tarifa) != null);
    if (asignacion.grupos.length === 0 && !hayParejasConPrecio) {
      faltaPrecio = true;
    } else {
      // Los domos que quedaron sin plan son los últimos armados (los menos llenos).
      const sinPlan = parejasArmadas.slice(parejasArmadas.length - asignacion.sinPlan);
      personasSinPlanPareja = sinPlan.reduce((n, d) => n + d.adultos + d.ninos, 0);
      const conPlan = parejasArmadas.slice(0, parejasArmadas.length - asignacion.sinPlan);
      const conUno = conPlan.filter((d) => d.adultos + d.ninos === 1).length;
      for (const g of asignacion.grupos) {
        const ocupacion =
          conUno > 0 && g === asignacion.grupos[asignacion.grupos.length - 1]
            ? `2 personas c/u, en ${conUno === 1 ? "uno va" : `${conUno} van`} 1`
            : "2 personas c/u";
        lineas.push(`💑 ${g.cantidad} × ${limpiar(g.plan.plan.nombre)} (${ocupacion}) — ${formatMoney(g.plan.precio)} c/u`);
        resumenDomos.push({ plan: g.plan.plan.nombre, cantidad: g.cantidad, precio_unitario: g.plan.precio, ocupacion });
        totalPesos += g.plan.precio * g.cantidad;
      }
    }
  }

  if (faltaPrecio || lineas.length === 0) return derivar("sin_precio", { domos: rep.domos.length });

  const sinAcomodar = rep.sinAcomodar + personasSinPlanPareja;
  const alcanza = sinAcomodar === 0;
  const cuantosDomos = resumenDomos.reduce((n, d) => n + d.cantidad, 0);

  const etiquetaTarifa = e.tarifa ? `, tarifa ${ETIQUETA_TARIFA[e.tarifa]}` : "; son valores desde, el exacto depende del día";
  const encabezado = `Para ${quien}${cuando} lo armo con ${cuantosDomos} domos:\n`;
  const lineaTotal = `\n\nTotal: ${formatMoney(totalPesos)} — valores sin IVA${etiquetaTarifa}.`;

  let cupo: string;
  if (!alcanza) {
    const acomodados = total - sinAcomodar;
    cupo =
      libres.origen === "lobby"
        ? `\n❌ Para esa fecha no me alcanzan los domos libres: con lo que hay acomodo a ${textoPersonas(Math.max(0, acomodados))} de ${total}. Te busco una fecha cercana donde sí quepan todos, si quieres.`
        : `\n⚠️ Con los domos que tengo no alcanzo a acomodar a todos (${textoPersonas(Math.max(0, acomodados))} de ${total}). Déjame confirmarlo con el equipo.`;
  } else if (!e.fecha) {
    cupo = "\n📅 Dime la fecha exacta y te confirmo el cupo de los " + cuantosDomos + " domos y el valor de ese día.";
  } else if (libres.origen === "lobby") {
    cupo = `\n✅ Para esa fecha SÍ hay cupo para los ${cuantosDomos} domos.`;
  } else {
    cupo = `\n🕐 El cupo exacto de los ${cuantosDomos} domos para esa fecha te lo confirma el equipo en un momento.`;
  }

  const notas: string[] = [];
  if (e.reparto.asumidoTodosAdultos) {
    notas.push(
      "Lo armé contando a todos como adultos. Si van niños, dime cuántos y sus edades: cambia el reparto y los menores tienen un valor adicional según la edad."
    );
  } else if (e.reparto.ninos > 0) {
    notas.push("Los niños tienen un valor adicional según la edad — está en el detalle del plan familiar.");
  }
  if (alcanza) {
    notas.push("Si prefieren una experiencia más completa (intermedio o todo incluido), te la cotizo también. ¿Les sirve así?");
  }

  return {
    result: {
      modo: "grupo",
      personas: total,
      adultos: e.reparto.adultos,
      ninos: e.reparto.ninos,
      fecha: e.fecha ?? null,
      tarifa: e.tarifa,
      domos: cuantosDomos,
      detalle: resumenDomos,
      total: totalPesos,
      alcanza,
      cupo_confirmado: libres.origen === "lobby",
      sin_acomodar: alcanza ? 0 : sinAcomodar,
    },
    reply_to_user: `${encabezado}${lineas.join("\n")}${lineaTotal}${cupo}${notas.length ? `\n\n${notas.join("\n\n")}` : ""}`,
    forzarTextoLiteral: true,
  };
}
