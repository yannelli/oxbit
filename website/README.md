# Oxbit website

Static marketing site for Oxbit, served as a Cloudflare Worker with static assets.
No build step. Everything under `public/` is deployed as is.

## Deploy

```sh
cd website
npm install
npx wrangler login
npm run deploy
```

`wrangler deploy` uploads `public/` and creates the `oxbit` Worker on
`oxbit.<account>.workers.dev`. Add a custom domain in the Cloudflare
dashboard under Workers & Pages → oxbit → Settings → Domains & Routes.

## Local preview

```sh
npm run dev
```

Serves the site at `http://localhost:8787` with the same asset handling as
production, including `404.html` and `_headers`.

## Layout

| Path | Contents |
| --- | --- |
| `public/index.html` | Landing page |
| `public/404.html` | Not-found page |
| `public/styles.css`, `public/main.js` | Styling, scroll reveal, copy buttons, terminal animation |
| `public/brand/` | Logo assets copied from `apps/web/public/brand` |
| `public/screens/` | Screenshots copied from `design/baselines` |
| `public/_headers` | Cache and security headers |
| `wrangler.jsonc` | Worker configuration |

This directory is outside the JavaScript workspace so `wrangler` does not join the
root lockfile.
