> **Featured project.** A browser-based 3D atlas that makes more than 2,800 anatomical structures explorable without installing specialist software.

# 3D Anatomy

An interactive 3D atlas of human anatomy: 2827 structures across seven systems,
built on the [Z-Anatomy](https://www.z-anatomy.com/) dataset and rendered in the
browser with three.js.

Live: <https://lyhtrn.github.io/medical-uncertainty/>

## Running it

Node 22.12 or newer (see `.nvmrc`).

```bash
npm ci        # postinstall copies the Draco decoder into public/draco/
npm run dev   # http://localhost:3000
npm test      # unit tests for the pure logic
npm run lint  # zero errors is the standard; console warnings are tolerated
npm run build # writes dist/, about 21 MB
```

`npm ci` is deliberate: `package.json` and the lockfile are kept in sync, and
the lockfile is the source of truth for the stack that has actually been tested.

## Document review prototype

The Documents panel accepts UTF-8 plain-text (`.txt`) and Markdown (`.md`)
files up to 2 MB and also accepts pasted report text. Its first-pass, English
keyword rules suggest symptom, investigation, or management findings and look
for English anatomical names in the atlas catalog, plus a small set of explicit
body-region terms. It keeps the source excerpt verbatim apart from surrounding
whitespace and reads an optional `Date:`, `Visit date:`, or `Report date:` field.

PDF, DOCX, image/scanned reports, OCR, non-English extraction, clinical
interpretation, and diagnosis are not implemented. Extraction is provisional:
reviewers must confirm a finding before a structure receives a medical status.
Only an unambiguous single structure/laterality match is proposed for a mesh.
Ambiguous or multiple matches are shown for review and do not color a mesh; to
color one, the reviewer must edit the match to an exact atlas structure.
Meshes default to grey; confirmed document findings color them red (documented
problem), orange (management in progress), or teal (currently investigating).
Selecting a colored structure shows its confirmed source excerpt. A
body-region-only mention creates a labeled region reference in the viewer; it
does not recolor anatomy meshes.
Files are parsed in the browser and are never uploaded. Document names, dates,
extracted excerpts, decisions, and confirmed statuses persist in localStorage;
the original report text is not retained by this prototype.

## How the models work

The seven `.glb` files in `public/models/` are exported from the Z-Anatomy
Blender file, which is **not** in this repository — it is 630 MB and lives in
`assets-src/` (gitignored). Download it from the Z-Anatomy site if you need to
regenerate the models.

Three conventions matter:

**`za_name` carries identity.** The glTF exporter rewrites object names — spaces
become underscores, dots vanish — and paired structures share their mesh data,
so `Femur.l` and `Femur.r` would collapse onto the same name. Every exported
object therefore carries its exact Z-Anatomy name in a custom property, written
into the glTF as `extras.za_name`. The application registers structures by that
value; nothing else is a stable id.

**The graph is flattened at load.** 868 structures are children of another
structure in the source, and three.js propagates `visible` down the subtree, so
hiding a parent used to hide unrelated children. `loadModel.js` detaches nested
structures to the model root (preserving the world transform) and records the
containment relation separately, which is what the details panel shows.

**Materials are shared.** The seven GLBs ship 65 materials (47 unique names)
for thousands of meshes. The loader keeps sharing the source materials and
medical-status variants; it clones a mesh's material only when that mesh needs
an independent appearance, restoring the base material when that state clears.

### Regenerating the models

Objects whose name ends in `.j` or `.g` are Z-Anatomy's text labels and are
skipped; so are meshes with one polygon or fewer, which are muscle insertion
markers. Select the collection for one system, then export GLB with
`export_extras=True` (for `za_name`), `export_apply=True` and Draco compression.
Deselect object by object rather than with `select_all(action='DESELECT')`:
the operator skips hidden objects, and a leftover selection silently ends up in
the next file.

Then run the optimiser, which also rewrites `systems.json` from what actually
survived, so the index can never list a structure the models do not contain:

```bash
node tools/optimise-models.mjs
```

### Regenerating the lexicon

Latin names and definitions ship inside the Blender file: a `Translations` text
block and one text block per structure, sourced from Wikipedia.

```bash
blender --background assets-src/Z-Anatomy/Startup.blend --python tools/export-lexicon.py
```

This writes `public/data/lexicon.json` (Latin names, non-official-terminology
flags) and `public/data/definitions.json` (definitions truncated to roughly 600
characters, with a link to the full article in the UI).

## What may live in public/

Only what should be served verbatim: the models, the upstream license notice
they ship with (`public/models/License.txt`, required by LICENSE/NOTICE), the
JSON data, the Draco decoder, the favicon. Anything Vite should process — the
stylesheet, the fonts —
belongs in `src/`, so it gets a content hash and cannot be served stale from a
browser cache. `public/` once held 900 MB of Blender sources and every build
copied them into `dist/`.

## Deployment

GitHub Actions builds and publishes to GitHub Pages on every push to `master`;
the workflow runs `npm ci`, `npm run lint` and `npm run build`, and the lint step
is blocking.

The site is served from a sub-path, so asset URLs are built from
`import.meta.env.BASE_URL` through `src/utils/paths.js`. Setting `base` in
`vite.config.js` alone would not rewrite string literals passed to `fetch()` or
to the loaders.

## Licence

The anatomical models are derived from BodyParts3D (CC BY-SA 2.1 Japan) and
Z-Anatomy (CC BY-SA 4.0), and definitions come from Wikipedia (CC BY-SA 3.0 /
GFDL). Two components are non-commercial — the inner ear (CC BY-NC-SA 4.0) and
the kidney (CC BY-NC 4.0) — so the work as distributed is **CC BY-NC-SA 4.0**:
attribution and share-alike are required and commercial use is not permitted.
Removing those two structures would allow the remainder to be redistributed
under CC BY-SA 4.0. See `LICENSE` and `NOTICE`.
