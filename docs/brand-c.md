# Mandala C / Open

The selected C direction has six pointed petals, open channels, mirrored side petals, and a continuous centered teardrop below the central opening. Two mirrored inward lobes sit inside that lower petal. This specific construction replaces the old mark's asymmetric pinwheel overlap; simply removing its colored seeds does not produce C.

## Geometry and use

| Asset | Construction | Use |
| --- | --- | --- |
| `src/assets/logo-petals.svg` | Six C petals and six inner turns; `currentColor` | Navigation, favicon, tray and full-size mark |
| `logo-on-light.svg` / `logo-on-dark.svg` | Full mark in `#232326` / `#ededf0` | Exported artwork on light / dark surfaces |
| `logo-black.svg` / `logo-white.svg` | Full mark in pure black / white | One-color production |
| `src/assets/app-icon.svg` | Full mark on a neutral charcoal rounded tile | Desktop application icon |
| `public/favicon.svg` | Full mark with system light / dark adaptation | Browser favicon |

All logo SVGs use a 100-unit viewBox, filled Bézier paths and genuine transparency. The C concept was reconstructed as explicit vector geometry: left and right side petals and inner turns are exact horizontal mirrors, while the upper and lower center petals are separately drawn to match their different shapes. It is not six identical rotated pieces. The lower side petals remain separate from the centered lower loop. The app icon alone has an opaque tile, with transparency outside its rounded corners.

`BrandMark` uses a single CSS mask in the surrounding heading color. Small application chrome uses the same twelve paths. Do not add an accent overlay, fill the central opening, or distort the proportions. Do not recolor marks with status colors; status belongs in a separate indicator.

## Reproducible exports

Run from the repository root after installing its pinned dependencies:

```sh
node scripts/brand-assets.mjs
node scripts/desktop-icons.mjs
npm test -- tests/brand-c.test.ts
```

The first script renders transparent PNG/SVG exports into `docs/design/brand/assets`. It includes actual 16, 24 and 32px versions and 64px full artwork. The second generates the neutral light/dark desktop PNGs, platform icon files, and tray icons. macOS `iconutil` builds the ICNS file. Windows ICO sizes 16/32 and macOS icon sizes 16/32 use the same app tile as larger sizes. The monochrome macOS tray uses 18pt template artwork at 1× and 2× for native tinting.

## Verification record

The previous seedless-original candidate failed independent review because its lower-right pinwheel overlap did not match C. The corrected candidate was compared side by side with the approved C reference before regenerating exports. Preserve this topology during future edits; color removal alone is insufficient.

The asset tests verify shared geometry, mirrored side petals, inward lobes and transparent cutouts.
