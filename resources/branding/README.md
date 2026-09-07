# Selected QA Logo

The user selected the stone badge concept on 2026-09-07. The original was generated
with the built-in image_gen tool. Preserve its artwork, colors, and transparency;
the application assets are size and format conversions only.

| File | Purpose |
| --- | --- |
| `logo-source.png` | Selected 1254 x 1254 RGBA original |
| `icon.png` | 512 x 512 Electron window icon |
| `icon.ico` | Windows executable icon, 16 through 256 pixels |
| `../../src/renderer/public/assets/qa-logo.png` | 256 x 256 navigation logo and favicon |

Regenerate the derived assets using existing Electron and electron-builder
dependencies, without an image API request:

```powershell
pnpm exec electron scripts/export-branding.cjs
```

## Original Generation Prompt

```text
Use case: logo-brand.
Asset type: original square desktop application logo and Windows icon for Ashes-of-Pantheon-QA-Tool, a QA companion to a dark-fantasy ancient-Roman card tactics game.
Primary request: create one original bold emblem matching the game's hand-painted UI: chipped stone tablets, bone-white carved symbols, aged gold trim, thick ink-black outlines, restrained red accents. A NEW logo, not a reproduction of an existing game title.
Scene/backdrop: genuinely transparent background with clean alpha; no background scene and no mockup.
Subject: a squat chipped charcoal stone tablet/shield containing one large interlocking QA monogram. The Q is an aged-gold open inspection ring, enclosing an angular ivory A whose broad silhouette evokes a classical temple pediment and two pillars. A short vermilion diagonal tail makes the Q unambiguous.
Style/medium: polished hand-inked 2D game emblem, crisp broad geometric strokes, restrained cel shading, a few large chipped facets and controlled stone texture. Not photorealistic or a shiny 3D render.
Composition: exactly one centered emblem, square 1:1 canvas, about 82 percent canvas coverage with even transparent padding; thick strokes readable at 32 pixels.
Color palette: charcoal #211e23, near-black #111012, bone ivory #eee7dc, aged gold #c6a451, vermilion #c44536.
Text (verbatim): "QA", only those two letters.
Avoid: tiny ornament, extra runes, gears, weapons, helmets, animals, flames, glow, gradients, scenes, extra badges, additional text, watermark, checkerboard drawn into the image.
```
