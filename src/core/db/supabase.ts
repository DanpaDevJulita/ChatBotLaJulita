import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabaseConfigured = Boolean(url && key);

if (!supabaseConfigured) {
  console.warn(
    "[supabase] Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el .env — el bot va a " +
      "responder con mensajes de 'todavía no tengo esa información' y el panel de " +
      "administración no va a poder guardar nada hasta que los configures."
  );
}

// OJO: esta es la SERVICE ROLE KEY, no la "anon key" — tiene permiso total y salta Row
// Level Security. Por diseño este cliente SOLO se importa desde código que corre en el
// servidor (src/core/db/*, src/web/admin/*) — nunca debe llegar al navegador. El panel de
// administración le pega a nuestras propias rutas de Express (/admin/api/...), que son las
// únicas que hablan con Supabase.
export const supabase = createClient(url ?? "https://placeholder.supabase.co", key ?? "placeholder", {
  auth: { persistSession: false },
});
