import crypto from "crypto";
import { supabaseAdmin } from "./db";
import { limpiarEnv } from "./env";
import { desencriptar } from "./crypto";
import { GRAPH_BASE } from "./graph";

export type Page = { id: string; name: string };
export type Project = { id: number; nombre: string; paginas: Page[]; error?: string };

/** Solo el worker (con la llave de servicio de Supabase) puede pedir el token de una página. */
export function autorizadoServicio(authHeader: string | null): boolean {
  const esperado = limpiarEnv(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  const recibido = (authHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!esperado || !recibido) return false;
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(esperado).digest(),
    crypto.createHash("sha256").update(recibido).digest(),
  );
}

/** Cuentas de Facebook conectadas por OAuth (proyectos) y sus páginas. Nunca devuelve tokens. */
export async function projects(): Promise<Project[]> {
  let data: any[] = [];
  try {
    const r = await supabaseAdmin
      .from("cuentas_fb")
      .select("id,nombre,token_encriptado,token_invalido_en")
      .order("creado_en", { ascending: false });
    if (r.error) {
      const again = await supabaseAdmin.from("cuentas_fb").select("id,nombre,token_encriptado").order("creado_en", { ascending: false });
      if (again.error) return [];
      data = again.data ?? [];
    } else {
      data = r.data ?? [];
    }
  } catch {
    return [];
  }

  return Promise.all(
    data.map(async (cuenta): Promise<Project> => {
      const out: Project = { id: Number(cuenta.id), nombre: String(cuenta.nombre || "Cuenta"), paginas: [] };
      if (cuenta.token_invalido_en) {
        out.error = "Token vencido: reconecta la cuenta en /facebook";
        return out;
      }
      try {
        const token = desencriptar(String(cuenta.token_encriptado || ""));
        const res = await fetch(
          `${GRAPH_BASE}/me/accounts?access_token=${encodeURIComponent(token)}&fields=id,name&limit=200`,
          { cache: "no-store", signal: AbortSignal.timeout(15000) },
        );
        const j: any = await res.json();
        if (j?.error) {
          out.error = j.error.message || "Facebook rechazó el token";
          return out;
        }
        out.paginas = (j.data || [])
          .filter((p: any) => /^\d+$/.test(String(p.id)))
          .map((p: any) => ({ id: String(p.id), name: String(p.name || p.id) }));
      } catch (e: any) {
        out.error = e?.message?.slice(0, 120) || "No se pudieron leer las páginas";
      }
      return out;
    }),
  );
}

/** Token fresco de una página, buscando en todos los proyectos conectados. Nunca se devuelve al navegador. */
export async function tokenDePagina(pageId: string): Promise<{ token: string; cuenta: number | null; error?: string }> {
  const { data: cuentas, error } = await supabaseAdmin
    .from("cuentas_fb")
    .select("id,token_encriptado")
    .order("creado_en", { ascending: false });
  if (error || !cuentas?.length) return { token: "", cuenta: null, error: "No hay cuentas de Facebook conectadas" };
  for (const cuenta of cuentas) {
    try {
      const token = desencriptar(String(cuenta.token_encriptado || ""));
      const res = await fetch(
        `${GRAPH_BASE}/me/accounts?access_token=${encodeURIComponent(token)}&fields=id,name,access_token&limit=200`,
        { cache: "no-store", signal: AbortSignal.timeout(15000) },
      );
      const j: any = await res.json();
      const page = (j.data || []).find((p: any) => String(p.id) === pageId);
      if (page?.access_token) return { token: String(page.access_token), cuenta: Number(cuenta.id) };
    } catch {
      // otra cuenta puede tener la página; seguimos
    }
  }
  return { token: "", cuenta: null, error: "Esa página no pertenece a ninguna cuenta conectada" };
}
