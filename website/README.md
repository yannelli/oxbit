# Oxbit website

Static marketing site for Oxbit, served as a Cloudflare Worker with static assets.
No build step. Everything under `public/` is deployed as is.
See the [website reference index](INDEX.md) for content maintenance and official
search documentation. Use it when adding pages or changing URLs and metadata.

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

The hero's version label is `<span data-version>` in `public/index.html`; `bun run release`
updates it with the other version files.

## Local preview

```sh
npm run dev
```

Serves the site at `http://localhost:8787` with the same asset handling as
production, including `404.html` and `_headers`.

## Checks

```sh
npm run check
```

Checks page metadata, structured data, FAQ answer parity, internal links and
anchors, navigation, sitemap coverage, robots directives, and JavaScript syntax,
then runs the Cloudflare deployment dry run. It does not publish the site.
Check desktop and mobile layouts in the local preview after visual changes.

## Layout

| Path | Contents |
| --- | --- |
| `public/index.html` | Landing page |
| `public/features/`, `public/platforms/` | Product details and supported systems |
| `public/get-started/`, `public/docs/` | Downloads, setup, and documentation directory |
| `public/changelog/`, `public/faq/` | Dated release highlights and direct answers |
| `public/about/`, `public/support/`, `public/security/`, `public/privacy/` | Project, help, trust boundaries, and privacy |
| `public/404.html` | Not-found page |
| `public/styles.css`, `public/main.js` | Styling, scroll reveal, copy buttons, terminal animation |
| `public/pages.css` | Shared navigation, subpages, and responsive styles |
| `public/sitemap.xml`, `public/robots.txt` | Canonical page discovery |
| `check.mjs` | Static content and navigation checks |
| `public/brand/` | Logo assets copied from `apps/web/public/brand` |
| `public/screens/` | Screenshots of the app; `/screens/*` is cached as immutable, so a new capture gets a new file name |
| `public/_headers` | Cache and security headers |
| `wrangler.jsonc` | Worker configuration |

This directory is outside the JavaScript workspace so `wrangler` does not join the
root lockfile.
