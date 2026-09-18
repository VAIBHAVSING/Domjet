# Domjet website

Static Astro website for `domjet.dev`. The custom landing page lives at `/`; Starlight serves the
documentation from `/docs` in the same build.

## Local development

```bash
npm install
npm run dev
```

Before publishing a change:

```bash
npm run check
npm run build
```

## Cloudflare Pages

Create a Pages project from this repository with:

- Root directory: `landing`
- Build command: `npm run build`
- Build output directory: `dist`
- Node.js version: 22.12 or newer

This project is fully static, so it does not need the Cloudflare Astro adapter or Pages Functions.
Cloudflare will deploy pull-request previews and rebuild the site when the production branch changes.

## Content and SEO

- Edit the landing page in `src/pages/index.astro`.
- Add documentation in `src/content/docs/docs` to keep it under `/docs`.
- Shared landing-page metadata lives in `src/layouts/BaseLayout.astro`.
- The production origin is configured once as `site` in `astro.config.mjs`.
- Sitemap files are generated during every build. `robots.txt`, structured data, canonical URLs,
  social metadata, a web manifest, and `llms.txt` are included from the start.
- Edit `public/social-card.svg` for link previews; the production PNG is regenerated before builds.
