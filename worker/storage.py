"""Storage del bucket 'clips': Supabase o Cloudflare R2 según STORAGE_DRIVER.

El bucket 'uploads' NO pasa por aquí: sigue en Supabase (branding, previews y subidas
del navegador). Así el cambio de egress queda limitado a los MP4/miniaturas de clips.

La interfaz es la misma para los dos drivers:
    upload(bucket, path, data, content_type)
    download(bucket, path) -> bytes
    signed_url(bucket, path, seconds, download=False) -> str | None
    remove(bucket, paths)
"""
import os

import config  # noqa: F401  (carga worker/.env)

CLIPS_BUCKET = "clips"
_client = None


def _env(name, default=""):
    return (os.environ.get(name) or default).strip()


def uses_r2(bucket=CLIPS_BUCKET):
    """Solo el bucket de clips se mueve a R2; el resto sigue igual."""
    driver = os.environ.get("STORAGE_DRIVER", config.STORAGE_DRIVER) or "supabase"
    return driver.strip().lower() == "r2" and bucket == CLIPS_BUCKET


def _bucket(bucket):
    return _env("R2_CLIPS_BUCKET", CLIPS_BUCKET) if bucket == CLIPS_BUCKET else bucket


def client():
    """Cliente S3 de R2 (se crea una vez). Se puede sustituir en los tests."""
    global _client
    if _client is None:
        import boto3

        account = _env("R2_ACCOUNT_ID")
        endpoint = _env("R2_ENDPOINT") or (f"https://{account}.r2.cloudflarestorage.com" if account else "")
        if not endpoint:
            raise RuntimeError("Falta R2_ACCOUNT_ID (o R2_ENDPOINT) en worker/.env")
        _client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=_env("R2_ACCESS_KEY_ID"),
            aws_secret_access_key=_env("R2_SECRET_ACCESS_KEY"),
            region_name="auto",
        )
    return _client


def _sb():
    import db  # import diferido: db.py importa este módulo

    return db.sb.storage


def upload(bucket, path, data, content_type):
    if uses_r2(bucket):
        client().put_object(Bucket=_bucket(bucket), Key=path, Body=data, ContentType=content_type)
        return None
    return _sb().from_(bucket).upload(path, data, {"content-type": content_type, "upsert": "true"})


def download(bucket, path):
    if uses_r2(bucket):
        body = client().get_object(Bucket=_bucket(bucket), Key=path)["Body"]
        return body.read()
    return _sb().from_(bucket).download(path)


def signed_url(bucket, path, seconds=3600, download=False):
    if uses_r2(bucket):
        params = {"Bucket": _bucket(bucket), "Key": path}
        if download:
            name = path.rsplit("/", 1)[-1].replace('"', "")
            params["ResponseContentDisposition"] = f'attachment; filename="{name}"'
        try:
            return client().generate_presigned_url("get_object", Params=params, ExpiresIn=int(seconds))
        except Exception:  # noqa: BLE001  ( igual que el respaldo de Supabase: devolver None )
            return None
    r = _sb().from_(bucket).create_signed_url(path, seconds)
    u = r.get("signedURL") or r.get("signed_url") or r.get("signedUrl")
    if u and not u.startswith("http"):
        u = f"{config.SUPABASE_URL.rstrip('/')}/storage/v1{u if u.startswith('/') else '/' + u}"
    return u


def remove(bucket, paths):
    paths = [p for p in paths if p]
    if not paths:
        return None
    if uses_r2(bucket):
        return client().delete_objects(
            Bucket=_bucket(bucket),
            Delete={"Objects": [{"Key": p} for p in paths]},
        )
    return _sb().from_(bucket).remove(paths)
