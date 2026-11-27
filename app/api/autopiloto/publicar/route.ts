import { NextRequest, NextResponse } from "next/server";
import { autorizadoServicio, tokenDePagina } from "@/lib/autopilot";
import { signClipPaths } from "@/lib/storage";
import { publicarEnPagina } from "@/lib/fbServer";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// El worker llama aquí con su llave de servicio: la web firma el clip (Tigris o Supabase),
// consigue el token fresco de la página y publica el Reel. Ningún token sale al navegador.
export async function POST(req: NextRequest) {
  if (!autorizadoServicio(req.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
  }
  const b = await req.json().catch(() => ({}));
  const pageId = String(b.page_id ?? "");
  const path = String(b.storage_path ?? "");
  if (!/^\d{5,}$/.test(pageId)) return NextResponse.json({ ok: false, error: "Página no válida" }, { status: 400 });
  if (!/^[\w./-]+\.mp4$/i.test(path) || path.includes("..")) {
    return NextResponse.json({ ok: false, error: "Archivo no válido" }, { status: 400 });
  }
  const title = String(b.title ?? "").slice(0, 255);
  const message = String(b.message ?? "").slice(0, 5000);

  try {
    const t = await tokenDePagina(pageId);
    if (!t.token) return NextResponse.json({ ok: false, error: t.error || "Sin token para esa página" }, { status: 404 });

    const signed = await signClipPaths([path], 6 * 3600);
    const url = signed[0]?.signedUrl;
    if (!url) return NextResponse.json({ ok: false, error: "No pude firmar el clip (revisa /almacenamiento)" }, { status: 500 });

    const r = await publicarEnPagina({
      paginaId: pageId,
      token: t.token,
      tipo: "reel",
      urlArchivo: url,
      titulo: title || null,
      mensaje: message || null,
    });
    return NextResponse.json(r);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
