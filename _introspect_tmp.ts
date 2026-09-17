import "dotenv/config";
import { supabase } from "./src/core/db/supabase.js";
const { data, error } = await supabase.from("tickets").select("*").order("id", { ascending: false }).limit(2);
console.log(JSON.stringify({ error: error?.message, cols: data?.[0] ? Object.keys(data[0]) : null, sample: data }, null, 1));
