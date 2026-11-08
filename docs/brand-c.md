# Mandala C / Open

The selected C direction has six pointed petals, open channels, mirrored side petals, and a continuous centered teardrop below the central opening. Two mirrored inward lobes sit inside that lower petal. This specific construction replaces the old mark's asymmetric pinwheel overlap; simply removing its colored seeds does not produce C.

## Geometry and use

| Asset | Construction | Use |
| --- | --- | --- |
| `src/assets/logo-petals.svg` | Six C petals and six inner turns; `currentColor` | Full mark, 48px and above |
| `src/assets/logo-small.svg` | The same six outer petals, without inner turns | Navigation, favicon and tray; 16–32px |
| `logo-on-light.svg` / `logo-on-dark.svg` | Full mark in `#232326` / `#ededf0` | Exported artwork on light / dark surfaces |
| `logo-black.svg` / `logo-white.svg` | Full mark in pure black / white | One-color production |
| `src/assets/app-icon.svg` | Full mark on a neutral charcoal rounded tile | Desktop application icon |
| `public/favicon.svg` | Optical small mark with system light / dark adaptation | Browser favicon |

All logo SVGs use a 100-unit viewBox, filled Bézier paths and genuine transparency. The C concept was reconstructed as explicit vector geometry: left and right side petals and inner turns are exact horizontal mirrors, while the upper and lower center petals are separately drawn to match their different shapes. It is not six identical rotated pieces. The lower side petals remain separate from the centered lower loop. The app icon alone has an opaque tile, with transparency outside its rounded corners.

`BrandMark` uses a single CSS mask in the surrounding heading color. Small application chrome uses the optical asset. Do not add an accent overlay, fill the central opening, distort the proportions, or use the full detailed mark at 16px. Do not recolor marks with status colors; status belongs in a separate indicator.

## Reproducible exports

Run from the repository root after installing its pinned dependencies:

```sh
node scripts/brand-assets.mjs
node scripts/desktop-icons.mjs
npm test -- tests/brand-c.test.ts
```

The first script renders transparent PNG/SVG exports into `docs/design/brand/assets`. It includes actual 16, 24 and 32px optical versions and 64px full artwork. The second generates the neutral light/dark desktop PNGs, platform icon files, and tray icons. macOS `iconutil` builds the ICNS file. Windows ICO sizes 16/32 and macOS icon sizes 16/32 use the optical artwork. The monochrome tray PNG is a black template with alpha, suitable for native tinting.

## Verification record

Chromium rendering was inspected on light (`#fcfcfc`) and dark (`#19191c`) UI fixtures, including navigation-sized marks and exact 16/24/32/64px samples. At 16px the six-point silhouette remains distinct; at 64px the inner turns are visible. This is a visual judgement, separate from asset consistency tests.

The previous seedless-original candidate failed independent review because its lower-right pinwheel overlap did not match C. The corrected candidate was compared side by side with the approved C reference before regenerating exports. Preserve this topology during future edits; color removal alone is insufficient.

The corrected vector's canvas checks at device scale 1 measured alpha 0 at the center for 16/24/32/64px. Painted pixel bounds, inclusive, were `(1,0)–(14,15)`, `(2,1)–(21,22)`, `(3,1)–(28,30)`, and `(6,3)–(57,60)` respectively. At 16px the tips reach the outermost row through antialiasing at alpha 9/255; all outermost-edge pixels at the other measured sizes are transparent. The SVG contours remain inside the viewBox.

The asset tests verify shared full-mark geometry, mirrored side petals and inward lobes, the optical outer-petal subset, favicon consistency, export consistency, true vector cutouts, and removal of the accent overlay. They do not replace whole-application or installed-App visual acceptance. Those remain release gates in the frontend rebuild plan.
