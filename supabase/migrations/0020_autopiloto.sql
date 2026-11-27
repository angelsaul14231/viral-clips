-- ClipForge · Piloto automático multi-página. Ejecútalo UNA VEZ en Supabase > SQL Editor.
-- Quita el CHECK viejo que solo permitía 3 redes y abre:
--   connections.network = 'autopilot'  (config del piloto, misma tabla 0013)
--   posts.network       = 'facebook:<id_de_página>'  (una fila por página)
-- Se puede correr varias veces. No toca datos existentes.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.connections'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(conoid) ILIKE '%network%'
  LOOP
    EXECUTE format('ALTER TABLE public.connections DROP CONSTRAINT %I', c.conname);
  END LOOP;

  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.posts'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(conoid) ILIKE '%network%'
  LOOP
    EXECUTE format('ALTER TABLE public.posts DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.connections ADD CONSTRAINT connections_network_check
  CHECK (network IN ('facebook','instagram','youtube','autopilot'));

ALTER TABLE public.posts ADD CONSTRAINT posts_network_check
  CHECK (network IN ('facebook','instagram','youtube') OR network ~ '^facebook:[0-9]+$');

-- La tabla puede existir sin la fila: el panel la crea al encender el piloto.
INSERT INTO public.connections (network, data)
VALUES ('autopilot', '{"enabled": false, "page_ids": [], "auto_approve": true, "max_per_run": 5}'::jsonb)
ON CONFLICT (network) DO NOTHING;
