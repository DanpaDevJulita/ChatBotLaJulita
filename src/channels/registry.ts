import type { ChannelAdapter } from "./types.js";

/**
 * Igual patrón que src/core/tools/registry.ts (y que tools/registry.ts en agente-ycloud-main):
 * un mapa nombre → implementación. Para agregar un canal nuevo, se registra aquí y no se
 * toca nada más.
 */
const adapters = new Map<string, ChannelAdapter>();

export function registerChannel(adapter: ChannelAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getChannel(name: string): ChannelAdapter {
  const adapter = adapters.get(name);
  if (!adapter) {
    throw new Error(`No hay adaptador registrado para el canal "${name}"`);
  }
  return adapter;
}
