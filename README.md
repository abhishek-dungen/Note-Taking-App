# Note-Taking App

A minimalist notes app with a Docs-style editor, reusable `#tags`, autosave, and Supabase sync.

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

## Supabase setup

1. Run the SQL in `supabase/setup.sql` inside the Supabase SQL Editor.
2. In Supabase Auth, enable Email provider for email/password sign-in.
3. If email confirmation is enabled, add your deployed site URL to Auth redirect/site settings and confirm new accounts before first sign-in.
4. The setup script also creates `public.touch_keepalive()`, which is used by GitHub Actions to keep the free-tier database warm.

## GitHub Pages deployment

This app is configured for GitHub Pages under the `Note-Taking-App` repository path.

1. Push this code to the `main` branch of `https://github.com/abhisheknitj2/Note-Taking-App`.
2. In GitHub, open `Settings > Pages`.
3. Set `Source` to `GitHub Actions`.
4. Every push to `main` will build and deploy automatically.

## Supabase keepalive

GitHub Actions runs `.github/workflows/supabase-keepalive.yml` twice a day at `02:17 UTC` and `14:17 UTC`. It calls the public `touch_keepalive` RPC on your Supabase project, so the database is touched from GitHub's cloud even when no devices are online.
