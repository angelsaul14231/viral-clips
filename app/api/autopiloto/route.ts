import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db";
import { projects } from "@/lib/autopilot";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const msg = (m: string) => {
  if (/violates check constraint|check constraint/i.test(m) && /network/i.test(m)) {
    return "Falta correr supabase/migrations/0020_autopiloto.sql en Supabase (abre las redes del piloto).";
  }
  if (/connections/i.test(m)) return "Falta correr 0013_conexiones.sql en Supabase";
  if (/posts/i.test(m)) return "Falta correr 0010_cola_publicacion.sql en Supabase";
  return m;
};

async function configRow() {
  const { data, error } = await supabaseAdmin.from("connections").select("data,updated_at").eq("network", "autopilot").maybeSingle();
  if (error) return { error: msg(error.message), data: null as any };
  const d = (data?.data ?? {}) as Record<string, unknown>;
  return {
    error: null,
    data: {
      enabled: Boolean(d.enabled),
      page_ids: (Array.isArray(d.page_ids) ? d.page_ids : []).map(String).filter((x) => /^\d+$/.test(x)),
      auto_approve: d.auto_approve === undefined ? true : Boolean(d.auto_approve),
      max_per_run: Number(d.max_per_run) || 5,
      updated_at: data?.updated_at ?? null,
    },
  };
}

export async function GET() {
  const [cfg, proyectos, clips, posts, ws] = await Promise.all([
    configRow(),
    projects(),
    supabaseAdmin.from("clips").select("id", { count: "exact", head: true }).in("viral_status", ["ready", "approved"]),
    supabaseAdmin.from("posts").select("id,status", { count: "exact" }).in("status", ["queued", "published"]).limit(1000),
    supabaseAdmin.from("worker_status").select("info,seen_at").eq("id", 1).maybeSingle(),
  ]);
  if (cfg.error) return NextResponse.json({ error: cfg.error }, { status: 500 });

  const rows = posts.data ?? [];
  const info = (ws.data?.info ?? {}) as Record<string, unknown>;
  return NextResponse.json({
    config: cfg.data,
    projects: proyectos,
    pages: proyectos.flatMap((p) => p.paginas.map((page) => ({ ...page, project: p.nombre, projectId: p.id }))),
    status: {
      workerAlive: !!ws.data?.seen_at && Date.now() - new Date(String(ws.data.seen_at)).getTime() < 5 * 60_000,
      seenAt: ws.data?.seen_at ?? null,
      workerAutopilot: info.autopilot === true,
      workerPages: Array.isArray(info.autopilot_pages) ? info.autopilot_pages : [],
      clipsReady: clips.count ?? 0,
      queued: rows.filter((p: any) => p.status === "queued").length,
      published: rows.filter((p: any) => p.status === "published").length,
    },
  });
}

/** Enciende/apaga el piloto, elige proyectos y llena la cola con lo que ya está listo. */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const action = String(b.action ?? "");
  const db = supabaseAdmin;

  if (action === "apagar") {
    const warnings: string[] = [];
    const cfg = await configRow();
    const previous = cfg.data?.page_ids ?? [];
    const r = await db.from("connections").upsert({
      network: "autopilot",
      data: { enabled: false, page_ids: previous, auto_approve: false, max_per_run: 5 },
      updated_at: new Date().toISOString(),
    });
    if (r.error) return NextResponse.json({ error: msg(r.error.message) }, { status: 500 });
    const sw = await db.from("app_switches").upsert({ id: 1, discover: false, auto_queue: false, updated_at: new Date().toISOString() });
    if (sw.error) warnings.push(msg(sw.error.message));
    return NextResponse.json({ ok: true, warnings });
  }

  if (action === "config" || action === "encender" || action === "encolar") {
    const current = await configRow();
    if (current.error) return NextResponse.json({ error: current.error }, { status: 500 });
    const raw = b.page_ids === undefined ? current.data.page_ids : b.page_ids;
    const page_ids = (Array.isArray(raw) ? raw : []).map(String).filter((x) => /^\d+$/.test(x));
    if (action !== "config" && !page_ids.length) {
      return NextResponse.json({ error: "Conecta una cuenta de Facebook y elige al menos una página" }, { status: 400 });
    }
    const max_per_run = Math.max(1, Math.min(25, Number(b.max_per_run ?? current.data.max_per_run) || 5));
    const auto_approve = action === "encender" ? true : b.auto_approve === undefined ? current.data.auto_approve : Boolean(b.auto_approve);
    if (action !== "encolar") {
      const r = await db.from("connections").upsert({
        network: "autopilot",
        data: { enabled: action === "encender" ? true : current.data.enabled, page_ids, auto_approve, max_per_run },
        updated_at: new Date().toISOString(),
      });
      if (r.error) return NextResponse.json({ error: msg(r.error.message) }, { status: 500 });
    }

    const warnings: string[] = [];
    if (action === "encender") {
      const sw = await db.from("app_switches").upsert({ id: 1, discover: true, auto_queue: true, updated_at: new Date().toISOString() });
      if (sw.error) warnings.push(msg(sw.error.message));
      const vc = await db.from("viral_config").upsert({ id: 1, require_approval: false, updated_at: new Date().toISOString() });
      if (vc.error) warnings.push("No pude desactivar la aprobación manual: " + msg(vc.error.message));
    }

    let queued = 0;
    if (action === "encolar" || b.encolar === true) {
      const { data: clips, error: eClips } = await db
        .from("clips")
        .select("id,storage_path,viral_status,publish_status,created_at")
        .in("viral_status", auto_approve ? ["ready", "approved"] : ["approved"])
        .not("storage_path", "is", null)
        .order("created_at", { ascending: false })
        .limit(50);
      if (eClips) return NextResponse.json({ error: msg(eClips.message) }, { status: 500 });
      const list = (clips ?? []).filter((c: any) => !["scheduled", "published"].includes(c.publish_status)).slice(0, max_per_run);
      const base = Date.now() + 60_000;
      const rows = list.flatMap((c: any, i: number) =>
        page_ids.map((p, j) => ({
          clip_id: c.id,
          network: `facebook:${p}`,
          scheduled_at: new Date(base + i * 12 * 60_000 + j * 45_000).toISOString(),
          status: "queued",
        })),
      );
      if (rows.length) {
        const up = await db.from("posts").upsert(rows, { onConflict: "clip_id,network", ignoreDuplicates: true });
        if (up.error) return NextResponse.json({ error: msg(up.error.message) }, { status: 500 });
        queued = rows.length;
      }
    }
    return NextResponse.json({ ok: true, queued, warnings, page_ids });
  }

  return NextResponse.json({ error: "Acción desconocida" }, { status: 400 });
}
