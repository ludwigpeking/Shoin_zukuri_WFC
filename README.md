# Shoin-zukuri WFC

A generator of Japanese shoin-zukuri halls and their gardens, built on wave function collapse:
pick a grid (square, bent or an irregular hexagon of quads), press Generate, and the roofs,
verandas, ponds and pines settle themselves. The ground can be raised and lowered by hand, the
time of day set, the light path traced, and a scheme saved and loaded as a file.

Live at https://shoin-zukuri-wfc.vercel.app/

Made with three.js, three-mesh-bvh and three-gpu-pathtracer.

## GitHub Pages

In the repository's **Settings → Pages → Build and deployment**, set **Source** to
**GitHub Actions**. The `Deploy GitHub Pages` workflow builds with Node.js 22 and publishes
the generated site whenever `main` is updated, or when the workflow is run manually.
The default Pages address is https://ludwigpeking.github.io/Shoin_zukuri_WFC/.
While the account's main Pages site uses `www.rattenstadt.com`, GitHub redirects this project
to https://www.rattenstadt.com/Shoin_zukuri_WFC/ as well.

The workflow sets Vite's base path to the repository name. The model and sky textures use
that same base path, so they load both on Pages and on the existing root-hosted Vercel site.
Use the workflow rather than serving the source or the previously committed `dist` directory.

To check the Pages build locally without changing the committed `dist` files:

```sh
npm ci
npm run build -- --base /Shoin_zukuri_WFC/ --outDir .pages-build
npm run serve -- --base /Shoin_zukuri_WFC/ --outDir .pages-build
```

Open the preview server at `/Shoin_zukuri_WFC/`. Pages hosts the static application;
the film's development-only `/film/kept-views` endpoint is available only with `npm run dev`.

## Rights

Copyright © 2023–2026 Richard Qian Li. All rights reserved.

The design, the models, the block set, the code and the pictures of this project are the
intellectual property of the author. The source is published for viewing and study. No part of it
may be copied, modified, redistributed or used in another work, commercial or not, without the
author's written permission.
