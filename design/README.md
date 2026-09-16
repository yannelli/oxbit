# Design assets

`brand/` contains the logo export script, outlined lettering, and preview images.
The browser assets and downloadable brand kit live in
[`apps/web/public/brand`](../apps/web/public/brand). See the
[variant guide](../apps/web/public/brand/variants/README.md) for sizes and regeneration.

`baselines/` contains the original design captures used by
[`tests/browser/acceptance.spec.ts`](../tests/browser/acceptance.spec.ts).
These cover desktop, tablet, and phone layouts in light and dark themes.
`baselines/dimensions.json` records the capture dimensions.

The current workbench is in `packages/workbench` and `packages/app-workbench`.
See [architecture](../docs/architecture.md) and [themes](../docs/themes/README.md)
for implementation details.
