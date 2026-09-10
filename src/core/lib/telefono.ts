/**
 * Normalización de números de celular para poder cruzarlos entre lo que el cliente usa en
 * WhatsApp (con o sin "+57", con o sin espacios) y lo que quedó guardado en `clientes.celular`
 * (texto libre, sin formato garantizado). Comparar solo los últimos N dígitos evita fallar por
 * el indicativo de país o algún espacio/guión de más.
 */
export function ultimosDigitos(numero: string | null | undefined, cuantos = 10): string {
  const soloDigitos = (numero ?? "").replace(/\D/g, "");
  return soloDigitos.slice(-cuantos);
}
