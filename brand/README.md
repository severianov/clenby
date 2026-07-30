# Clenby brand assets

Source of truth for the extension icon. The PNGs in `public/icon/` are
**generated** from these — edit the SVG, re-run the command below, never hand-edit
a PNG.

| File | Used for |
|---|---|
| `clenby-mark.svg` | 128 / 48 / 32 — the full mark, C + chevron |
| `clenby-mark-16.svg` | 16 only — C alone, heavier stroke |

## Regenerate

```sh
for s in 128 48 32; do rsvg-convert -w $s -h $s brand/clenby-mark.svg -o public/icon/$s.png; done
rsvg-convert -w 16 -h 16 brand/clenby-mark-16.svg -o public/icon/16.png
```

`rsvg-convert` ships with librsvg (`pacman -S librsvg`, `brew install librsvg`).

## Why there are two files

At 16px the chevron's 4.6 stroke renders at ~1.1px — below the width where
antialiasing preserves a shape, so it reads as a grey smudge inside the bowl
rather than a chevron. The 16px file drops it and thickens the C to carry the
mark alone. This is normal for icon sets; don't "fix" it by scaling the full
mark down.

## Geometry notes

- 64×64 grid, corner radius 14 (21.9%).
- The glyph group is translated `+3` on x. The C's aperture is on the right, so
  its mass sits left of true centre — the offset makes it *look* centred. Keep it
  if you redraw.
- Indigo `#4F46E5`, mark in pure white. Deliberately not Claude terracotta: the
  previous icon was a white sparkle on terracotta, i.e. Anthropic's own mark,
  which risks a Chrome Web Store rejection for implying affiliation.
