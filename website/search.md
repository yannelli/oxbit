# Search and content maintenance

Created: 2026-10-19. Last updated: 2026-10-19.

Pages are static HTML. Keep navigation and footer links consistent across pages.
Each indexable page has a unique title, description, absolute canonical URL,
Open Graph and Twitter metadata, and page JSON-LD. Breadcrumbs describe each subpage.
The homepage describes the application and its named maintainer. FAQ structured
answers match the visible answers. Do not add reviews or ratings without evidence.

When adding a page, add its canonical URL to `public/sitemap.xml` and link it from
an existing page. Keep the 404 page excluded and marked `noindex`. `robots.txt`
references the sitemap. The sitemap omits modification dates to avoid stale dates.

When adding a changelog entry, use its GitHub release date and published notes.
Keep older entry anchors stable. Link the release and source notes so readers can
check the summary. The release script updates the homepage's `span[data-version]`;
preserve that element and update release highlights separately.

Run `npm run check` in this directory after content changes. Check desktop and
mobile layouts, the menu, FAQ expansion, and command copying in the local preview.
Structured data describes visible content; it does not promise a search result format.

## Official references

- [Google: canonical URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls): use when changing page URLs or canonical tags.
- [Google: build a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap): use when adding or removing indexable pages.
- [Google: structured data guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies): use when editing JSON-LD and its visible source content.
