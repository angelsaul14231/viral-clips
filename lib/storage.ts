// Storage del bucket 'clips': Supabase o Cloudflare R2 según STORAGE_DRIVER.
// El bucket 'uploads' y el de publicaciones de Facebook NO pasan por aquí.
import type { SupabaseClient } from "@supabase/supabase-js";

const CLIPS_BUCKET = "clips";

export function clipsOnR2(): boolean {
  return (process.env.STORAGE_DRIVER || "supabase").trim().toLowerCase() === "r2";
}

let cached: any = null;

async function s3() {
  if (!cached) {
    const { S3Client } = await import("@aws-sdk/client-s3");
    const account = process.env.R2_ACCOUNT_ID || "";
    const endpoint = process.env.R2_ENDPOINT || (account ? `https://${account}.r2.cloudflarestorage.com` : "");
    if (!endpoint) throw new Error("Falta R2_ACCOUNT_ID o R2_ENDPOINT en el entorno");
    cached = new S3Client({
      endpoint,
      region: "auto",
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
      },
    });
  }
  return cached;
}

export type SignedClip = { path: string; signedUrl: string | null };

/** Firma rutas de clips igual que createSignedUrls, pero contra R2 cuando está activo. */
export async function signClipPaths(
  paths: string[],
  seconds = 3600,
  download = false,
  db?: SupabaseClient,
): Promise<SignedClip[]> {
  if (!paths.length) return [];

  if (!clipsOnR2()) {
    const client = db ?? (await import("./db")).supabaseAdmin;
    const { data } = await client.storage.from(CLIPS_BUCKET).createSignedUrls(
      paths,
      seconds,
      download ? { download: true } : undefined,
    );
    const byPath = new Map<string, string>();
    (data || []).forEach((x: any) => {
      if (x?.path && x?.signedUrl) byPath.set(x.path, x.signedUrl);
    });
    return paths.map((path) => ({ path, signedUrl: byPath.get(path) ?? null }));
  }

  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const bucket = process.env.R2_CLIPS_BUCKET || CLIPS_BUCKET;
  const client = await s3();
  return Promise.all(
    paths.map(async (path) => {
      try {
        const params: any = { Bucket: bucket, Key: path };
        if (download) {
          const name = path.split("/").pop()?.replace(/"/g, "") || "clip.mp4";
          params.ResponseContentDisposition = `attachment; filename="${name}"`;
        }
        return { path, signedUrl: await getSignedUrl(client, new GetObjectCommand(params), { expiresIn: seconds }) };
      } catch (e) {
        console.error("No se pudo firmar en R2:", path, e);
        return { path, signedUrl: null };
      }
    }),
  );
}

/** Borra archivos del bucket de clips (R2 o Supabase). */
export async function removeClipFiles(paths: string[], db?: SupabaseClient): Promise<{ error: string | null }> {
  const clean = paths.filter(Boolean);
  if (!clean.length) return { error: null };

  if (!clipsOnR2()) {
    const client = db ?? (await import("./db")).supabaseAdmin;
    const { error } = await client.storage.from(CLIPS_BUCKET).remove(clean);
    return { error: error?.message ?? null };
  }

  try {
    const { DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
    const bucket = process.env.R2_CLIPS_BUCKET || CLIPS_BUCKET;
    await (await s3()).send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: clean.map((Key) => ({ Key })) } }),
    );
    return { error: null };
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
}
