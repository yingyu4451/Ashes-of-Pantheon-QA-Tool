# Game UI artwork

These PNGs are lossless extracts of existing project art, used by the QA tool's
Vue/daisyUI skin. No runtime access to Unity is required. The original Unity
project and the selected QA logo are unchanged.

Source Unity project: `D:\Unity Project\Not Happy Hotel`.
Unity texture root: `Assets/Arts/Textures/UI/`.

| Export | Source | Sprite / rectangle |
| --- | --- | --- |
| `button-stone.png` | `PSD_UI_0.psd` | `PSD_UI_0_1`: 246, 1964, 428, 68 |
| `frame-gold.png` | `PSD_UI_0.psd` | `PSD_UI_0_35`: 133, 225, 326, 226 |
| `frame-stone.png` | `PSD_UI_0.psd` | `PSD_UI_0_62`: 138, 35, 320, 161 |
| `nav-selected.png` | `PSD_UI_2.psd` | `PSD_UI_2_45`: 3163, 3875, 416, 174 |
| `nav-stone.png` | `PSD_UI_2.psd` | `PSD_UI_2_46`: 3613, 3875, 416, 174 |
| `panel-stone.png` | `PSD_UI_1.psd` | `PSD_UI_1_0`: 97, 2681, 832, 1326 |
| `stone-surface.png` | `三选一底.png` | Top-left crop: 580, 450, 3300, 1700 |

Sprite rectangles use Unity's bottom-left `(x, y, width, height)` convention.
For a source image of height H, the equivalent Pillow crop is
`(x, H-y-height, x+width, H-y)`. PSDs were decoded from their stored composite
with Pillow; original colors and alpha are retained. The stone surface uses a
top-left `(left, top, right, bottom)` crop of the undecorated center.

The four `card-frame-N.png` images are cropped from the tool's existing
`src/renderer/public/assets/card-frame.png`, preserving its established variant
order. The current Unity card PSD has a different set of three frames, so it
does not replace the tool's four variants. Top-left crop coordinates:

| Variant | Crop (left, top, right, bottom) |
| --- | --- |
| 0: plain stone | 111, 11, 402, 503 |
| 1: teal crystal | 623, 11, 914, 503 |
| 2: red crystal | 110, 525, 401, 1015 |
| 3: silver crystal | 623, 523, 914, 1013 |

Frame crops remove unused atlas space; CSS clips the remaining outer corners.
Card dimensions, content insets, category icons, variant mapping and runtime
card illustrations keep their existing behavior. Border images and backgrounds
are decorative and do not change workspace columns or control hit areas.
