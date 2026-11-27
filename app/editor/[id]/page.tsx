"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type EditorClip = {
  id: string;
  title: string;
  start_sec: number;
  end_sec: number;
  viral_score?: number | null;
  description?: string | null;
  hashtags?: string[] | null;
  storage_path?: string | null;
  sourceKind?: string | null;
  sourceTitle?: string | null;
  videoUrl?: string | null;
  downloadUrl?: string | null;
  thumbUrl?: string | null;
  thumbBUrl?: string | null;
  viral?: { hook_score?: number; thumb_text?: string } | null;
};

type Tab = "recorte" | "encuadre" | "texto" | "miniatura";

const LAYOUTS = [
  { id: "crop", icon: "▣", label: "Vertical", hint: "Llena la pantalla 9:16" },
  { id: "split", icon: "◫", label: "Split", hint: "Original arriba, recorte abajo" },
  { id: "split_eq", icon: "◧", label: "Split 50/50", hint: "Dos mitades iguales" },
  { id: "split_game", icon: "◪", label: "Gaming", hint: "Cara + pantalla de juego" },
  { id: "blur", icon: "▤", label: "Difuminado", hint: "Fondo borroso, centro limpio" },
  { id: "duo", icon: "◱", label: "Dúo", hint: "Dos caras lado a lado" },
];
const STYLES = ["rojo", "blanco", "negro", "amarillo", "centro", "arriba"];
const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export default function EditorPage({ params }: { params: { id: string } }) {
  const [clip, setClip] = useState<EditorClip | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("recorte");
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(60);
  const [duration, setDuration] = useState(60);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [layout, setLayout] = useState("crop");
  const [hook, setHook] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [thumbText, setThumbText] = useState("");
  const [thumbStyle, setThumbStyle] = useState("rojo");
  const [frame, setFrame] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/clips/${params.id}`, { cache: "no-store" });
        const j = await r.json();
        if (!alive) return;
        if (!r.ok) throw new Error(j.error || "No se pudo cargar el clip");
        const c: EditorClip = j.clip;
        setClip(c);
        setStart(Number(c.start_sec) || 0);
        setEnd(Number(c.end_sec) || 60);
        setTitle(c.title || "");
        setDescription(c.description || "");
        setTags((c.hashtags || []).join(" "));
        setHook(c.viral?.thumb_text || "");
        setThumbText(c.viral?.thumb_text || "");
        if (c.videoUrl) setError("");
        else setError("Este clip no tiene archivo de video. Espera a que el worker lo termine.");
      } catch (e: any) {
        if (alive) setError(e?.message || "Error de conexión");
      }
    })();
    return () => { alive = false; };
  }, [params.id]);

  const seek = useCallback((t: number) => {
    const v = video.current;
    if (!v || !Number.isFinite(t)) return;
    v.currentTime = clamp(t, 0, duration || 0);
    setCurrent(v.currentTime);
  }, [duration]);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) { v.play().catch(() => {}); setPlaying(true); }
    else { v.pause(); setPlaying(false); }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      else if (e.key.toLowerCase() === "i") setStart(clamp(current, 0, Math.max(0, end - 5)));
      else if (e.key.toLowerCase() === "o") setEnd(clamp(current, start + 5, duration || current + 5));
      else if (e.key === "ArrowLeft") { e.preventDefault(); seek(current - (e.shiftKey ? 5 : 1)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); seek(current + (e.shiftKey ? 5 : 1)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, duration, end, seek, start, togglePlay]);

  function setStartSafe(v: number) { setStart(clamp(v, 0, Math.max(0, end - 5))); }
  function setEndSafe(v: number) { setEnd(clamp(v, Math.min(duration, start + 5), duration)); }

  function applyLength(sec: number) {
    const s = start;
    const e = Math.min(duration, s + sec);
    if (e - s < 5) { setNote({ ok: false, text: "El inicio está muy al final del video para ese largo" }); return; }
    setEnd(e);
    seek(e - 0.1);
  }

  function capture(): string | null {
    const v = video.current;
    if (!v || !v.videoWidth) return null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(720, v.videoWidth);
      canvas.height = Math.round(canvas.width * (v.videoHeight / v.videoWidth));
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", 0.82);
      setFrame(url);
      return url;
    } catch {
      setNote({ ok: false, text: "El navegador no permite capturar este video; el worker igual puede hacer la miniatura." });
      return null;
    }
  }

  async function thumbs(slot: "a" | "b") {
    setBusy(true); setNote(null);
    capture();
    const body = { action: "thumbs", id: clip!.id, [slot]: { text: thumbText || title.slice(0, 24), style: thumbStyle, time: Math.round(current * 10) / 10 } };
    try {
      const r = await fetch("/api/viral", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      setNote(r.ok
        ? { ok: true, text: `Miniatura ${slot.toUpperCase()} en cola: el worker la genera en segundos.` }
        : { ok: false, text: j.error || "No se pudo pedir la miniatura" });
    } catch {
      setNote({ ok: false, text: "Sin conexión con el servidor" });
    }
    setBusy(false);
  }

  async function save() {
    if (!clip) return;
    if (end - start < 5) { setNote({ ok: false, text: "El clip debe durar al menos 5 segundos" }); return; }
    setBusy(true); setNote(null);
    try {
      const meta = await fetch("/api/viral", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit", id: clip.id, title, description, hashtags: tags.split(/\s+/).filter(Boolean) }),
      });
      const mj = await meta.json().catch(() => ({}));
      if (!meta.ok) throw new Error(mj.error || "No se pudo guardar el texto");

      if (clip.sourceKind === "live") {
        setNote({ ok: true, text: "Texto guardado. Los clips de directo no se pueden recortar después (el directo ya pasó)." });
        setBusy(false);
        return;
      }
      const r = await fetch(`/api/clips/${clip.id}/rerender`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, layout, hook: hook || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      setNote(r.ok
        ? { ok: true, text: "Guardado y en cola. El worker está renderizando la nueva versión." }
        : { ok: false, text: j.error || "No se pudo pedir el render" });
    } catch (e: any) {
      setNote({ ok: false, text: e?.message || "Error inesperado" });
    }
    setBusy(false);
  }

  if (error && !clip) return (
    <div className="page"><div className="card">
      <h2>No se pudo abrir el editor</h2><p style={{ color: "var(--muted)" }}>{error}</p>
      <Link className="btn ghost sm" href="/biblioteca">← Volver a la biblioteca</Link>
    </div></div>
  );
  if (!clip) return <div className="page"><p style={{ color: "var(--muted)" }}>Cargando editor…</p></div>;

  const len = Math.max(0, end - start);
  const disabledRender = clip.sourceKind === "live" || !clip.videoUrl;

  return (
    <div className="page" style={{ maxWidth: 1440 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Link className="btn ghost sm" href="/biblioteca">← Biblioteca</Link>
        <div style={{ minWidth: 220, flex: 1 }}>
          <h1 style={{ fontSize: 22, margin: 0 }}>Editor de clip</h1>
          <p style={{ color: "var(--muted)", margin: "2px 0 0", fontSize: 13 }}>
            {clip.sourceTitle || clip.title} · {fmt(len)} · {clip.viral_score ?? "—"}%
          </p>
        </div>
        <span className="pill ghost">{clip.sourceKind === "live" ? "Directo" : "Video"}</span>
        {clip.downloadUrl && <a className="btn ghost sm" href={clip.downloadUrl} target="_blank" rel="noreferrer">⬇ Descargar</a>}
        <button className="btn" disabled={busy || disabledRender} onClick={save}>{busy ? "Guardando…" : "💾 Guardar y renderizar"}</button>
      </div>

      {note && <div className="card" style={{ borderColor: note.ok ? "rgba(16,185,129,.5)" : "rgba(244,63,94,.5)", marginBottom: 14, padding: "10px 14px" }}>
        <span style={{ color: note.ok ? "var(--emerald2)" : "var(--red2)" }}>{note.ok ? "✓" : "⚠"}</span> {note.text}
      </div>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 1.05fr) minmax(340px, .95fr)", gap: 18, alignItems: "start" }}>
        <div>
          <div className="card" style={{ padding: 12 }}>
            <div style={{ position: "relative", background: "#000", borderRadius: 12, overflow: "hidden", display: "grid", placeItems: "center" }}>
              {clip.videoUrl ? (
                <video ref={video} src={clip.videoUrl} poster={clip.thumbUrl || undefined} controls playsInline preload="metadata"
                  style={{ width: "100%", maxHeight: "62vh", objectFit: "contain", display: "block" }}
                  onLoadedMetadata={(e) => { const d = e.currentTarget.duration || 60; setDuration(d); setEnd((v) => clamp(v || d, 0, d)); }}
                  onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
                  onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
              ) : <div style={{ aspectRatio: "9/16", maxHeight: "55vh", display: "grid", placeItems: "center", color: "var(--muted)" }}>Sin video disponible</div>}
              {hook && <div style={{ position: "absolute", top: "6%", left: "6%", right: "6%", textAlign: "center", pointerEvents: "none" }}>
                <span style={{ background: "rgba(0,0,0,.55)", color: "#fff", fontWeight: 800, fontSize: "clamp(15px, 2.5vw, 26px)", padding: "6px 14px", borderRadius: 10, textShadow: "0 2px 8px #000" }}>{hook.slice(0, 70)}</span>
              </div>}
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
                <span>Línea de tiempo · <b style={{ color: "var(--text)" }}>{fmt(current)}</b> / {fmt(duration)}</span>
                <span>Selección: {fmt(start)} → {fmt(end)} ({fmt(len)})</span>
              </div>
              <div style={{ position: "relative", height: 34, borderRadius: 8, background: "linear-gradient(90deg,#0b1022,#131d3a)", border: "1px solid var(--line)", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, bottom: 0, left: `${(start / (duration || 1)) * 100}%`, width: `${(len / (duration || 1)) * 100}%`, background: "linear-gradient(90deg,rgba(99,102,241,.55),rgba(34,211,238,.4))", borderLeft: "2px solid var(--cyan2)", borderRight: "2px solid var(--red2)" }} />
                <div style={{ position: "absolute", top: 0, bottom: 0, left: `${(current / (duration || 1)) * 100}%`, width: 2, background: "#fff", boxShadow: "0 0 8px #fff" }} />
                <input aria-label="Inicio del clip" type="range" min={0} max={duration} step={0.1} value={start} onChange={(e) => setStartSafe(Number(e.target.value))}
                  style={{ position: "absolute", inset: 0, width: "100%", opacity: 0, cursor: "ew-resize" }} />
              </div>
              <div className="row" style={{ gridTemplateColumns: "repeat(2, 1fr)", marginTop: 10 }}>
                <label>Inicio <input type="number" min={0} max={Math.max(0, end - 5)} step={0.1} value={Number(start.toFixed(1))} onChange={(e) => setStartSafe(Number(e.target.value))} /></label>
                <label>Fin <input type="number" min={start + 5} max={duration} step={0.1} value={Number(end.toFixed(1))} onChange={(e) => setEndSafe(Number(e.target.value))} /></label>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                {[15, 30, 45, 60].map((s) => <button key={s} className="btn ghost sm" onClick={() => applyLength(s)}>{s}s</button>)}
                <button className="btn ghost sm" onClick={() => { setStartSafe(current); seek(current); }}>I · Marcar inicio</button>
                <button className="btn ghost sm" onClick={() => { setEndSafe(current); seek(current); }}>O · Marcar fin</button>
                <button className="btn ghost sm" onClick={togglePlay}>{playing ? "⏸ Pausa" : "▶ Reproducir"}</button>
              </div>
              <p style={{ color: "var(--muted2)", fontSize: 11, marginTop: 8 }}>Atajos: Espacio reproducir · I inicio · O fin · ←/→ mover 1s (Shift 5s)</p>
            </div>
          </div>
        </div>

        <div className="card" style={{ padding: 18 }}>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 16 }}>
            {(["recorte", "encuadre", "texto", "miniatura"] as Tab[]).map((t) => (
              <button key={t} className={`btn sm ${tab === t ? "" : "ghost"}`} onClick={() => setTab(t)}>
                {t === "recorte" ? "✂ Recorte" : t === "encuadre" ? "▣ Encuadre" : t === "texto" ? "✎ Texto" : "🖼 Miniatura"}
              </button>
            ))}
          </div>

          {tab === "recorte" && (
            <div>
              <h3 style={{ fontSize: 16 }}>Puntos de corte</h3>
              <p style={{ color: "var(--muted)", fontSize: 13 }}>Mueve el cursor en el video y marca el inicio y el fin. Luego guarda para que el worker vuelva a renderizar.</p>
              <div className="row" style={{ gridTemplateColumns: "repeat(2, 1fr)", marginTop: 14 }}>
                <button className="btn ghost sm" onClick={() => seek(start)}>Ir al inicio</button>
                <button className="btn ghost sm" onClick={() => seek(Math.max(0, end - 0.5))}>Ir al fin</button>
              </div>
              <div style={{ marginTop: 16, padding: 12, borderRadius: 10, background: "var(--glass)", border: "1px solid var(--glass-border)" }}>
                <b style={{ fontSize: 13 }}>Duración final:</b> <span style={{ color: "var(--cyan2)" }}>{fmt(len)}</span>
                <p style={{ color: "var(--muted2)", fontSize: 11, marginTop: 4 }}>Entre 5 y 180 s. El worker ajusta el corte a pausas naturales.</p>
              </div>
            </div>
          )}

          {tab === "encuadre" && (
            <div>
              <h3 style={{ fontSize: 16 }}>Encuadre</h3>
              <p style={{ color: "var(--muted)", fontSize: 13 }}>Elige cómo se ve el video original dentro del formato vertical.</p>
              <div className="grid3" style={{ gridTemplateColumns: "repeat(2, 1fr)", marginTop: 14 }}>
                {LAYOUTS.map((l) => (
                  <button key={l.id} onClick={() => setLayout(l.id)} className="btn ghost sm"
                    style={{ textAlign: "left", padding: 12, borderColor: layout === l.id ? "var(--cyan)" : undefined, background: layout === l.id ? "rgba(34,211,238,.12)" : undefined }}>
                    <div style={{ fontSize: 22 }}>{l.icon}</div>
                    <b>{l.label}</b><div style={{ color: "var(--muted2)", fontSize: 11 }}>{l.hint}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {tab === "texto" && (
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <h3 style={{ fontSize: 16 }}>Texto y publicación</h3>
                <p style={{ color: "var(--muted)", fontSize: 13 }}>Se guarda en el clip y se usa en el paquete de TikTok, Reels y Shorts.</p>
              </div>
              <label>Título <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Título del clip" /></label>
              <label>Gancho en pantalla <input value={hook} maxLength={70} onChange={(e) => setHook(e.target.value)} placeholder="¡MIRA ESTO!" /><small style={{ color: "var(--muted2)" }}>{hook.length}/70 · aparece arriba en la vista previa</small></label>
              <label>Descripción <textarea value={description} rows={3} maxLength={2200} onChange={(e) => setDescription(e.target.value)} placeholder="Texto para la publicación" /></label>
              <label>Hashtags <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#viral #fyp #alofoke" /></label>
            </div>
          )}

          {tab === "miniatura" && (
            <div>
              <h3 style={{ fontSize: 16 }}>Miniatura A/B</h3>
              <p style={{ color: "var(--muted)", fontSize: 13 }}>Pausa en el cuadro que quieras, escribe el texto y pide la miniatura. El worker la genera en segundos.</p>
              <div style={{ margin: "14px 0", borderRadius: 10, overflow: "hidden", border: "1px solid var(--line)", background: "#000", aspectRatio: "9/16", maxWidth: 220 }}>
                {frame ? <img src={frame} alt="Cuadro capturado" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : <div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--muted2)", fontSize: 12 }}>Pausa y captura un cuadro</div>}
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                <label>Texto <input value={thumbText} maxLength={40} onChange={(e) => setThumbText(e.target.value)} placeholder="¿LO VISTE?" /></label>
                <label>Estilo <select value={thumbStyle} onChange={(e) => setThumbStyle(e.target.value)}>{STYLES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
                <p style={{ color: "var(--muted2)", fontSize: 12 }}>Cuadro actual: <b style={{ color: "var(--text)" }}>{fmt(current)}</b></p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn ghost sm" disabled={busy} onClick={() => capture()}>📸 Capturar</button>
                  <button className="btn ghost sm" disabled={busy} onClick={() => thumbs("a")}>Miniatura A</button>
                  <button className="btn ghost sm" disabled={busy} onClick={() => thumbs("b")}>Miniatura B</button>
                </div>
                {(clip.thumbUrl || clip.thumbBUrl) && <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                  {clip.thumbUrl && <a href={clip.thumbUrl} target="_blank" rel="noreferrer" style={{ color: "var(--cyan2)", fontSize: 12 }}>Ver A ↗</a>}
                  {clip.thumbBUrl && <a href={clip.thumbBUrl} target="_blank" rel="noreferrer" style={{ color: "var(--cyan2)", fontSize: 12 }}>Ver B ↗</a>}
                </div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
