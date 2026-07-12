# Agate Identifier — Vision Backend

A tiny Cloudflare Worker that receives a rock photo (base64) and asks Claude
(`claude-haiku-4-5`) whether it shows a Lake Superior agate, returning
structured JSON: verdict, confidence, a normalized bounding box (`x_min`,
`y_min`, `x_max`, `y_max` as fractions of the image, plus a plain-language
`location_description`) marking the most agate-like region, and a
per-criterion breakdown (banding, color palette, translucency & luster,
shape & texture).

This exists because pixel-based heuristics can't reliably tell a rock from
its background — this calls a real vision model instead.

## Deploy

1. Install dependencies:
   ```
   cd worker
   npm install
   ```
2. Log in to Cloudflare (opens a browser):
   ```
   npx wrangler login
   ```
3. Store your Anthropic API key as a secret (never goes in the repo):
   ```
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
   Paste your key from https://console.anthropic.com when prompted.
4. (Recommended) Lock down CORS to your actual site instead of `*` — edit
   `ALLOWED_ORIGIN` in `wrangler.toml`, e.g.:
   ```
   ALLOWED_ORIGIN = "https://jgriffin187.github.io"
   ```
5. Deploy:
   ```
   npm run deploy
   ```
   Wrangler prints your Worker's URL, something like:
   ```
   https://agate-identifier.<your-subdomain>.workers.dev
   ```
6. Open `../agate-identifier.html` and set `API_ENDPOINT` near the top of
   the `<script>` block to that URL.

## Local testing

```
npm run dev
```

Then `curl` it with a small base64 test image, or point the frontend's
`API_ENDPOINT` at `http://localhost:8787` during development.

## Reference photos

`src/referenceImages.ts` holds a calibration photo sent alongside every
scan — real, confirmed examples that help Claude judge harder cases (like
dry rocks, where agates look much subtler than wet ones) instead of relying
on the text prompt alone. To add or replace one:

1. Resize the photo to ~1000px on the longest side, JPEG, quality ~80
   (keeps token cost and bundle size down).
2. Base64-encode it and export it as a constant from `referenceImages.ts`,
   the same shape as `DRY_AGATE_REFERENCE_BASE64`.
3. Reference it in the `messages` array in `src/index.ts`, with a caption
   telling Claude what it's confirmed to be and what to notice.

Keep the total number of reference images small (2-4) — each one adds to
every request's token cost and prompt length. A photo showing a rock that
*isn't* an agate but looks like one (a "hard negative") is often more
useful than another positive example.

## Cost

`claude-haiku-4-5` pricing is $1/$5 per million input/output tokens. A
typical scan (the downsized photo + a reference calibration photo baked
into every request + prompt + a short JSON response) costs roughly
$0.004–$0.008 (under a cent). Cloudflare Workers' free tier covers
100,000 requests/day, so hosting cost is $0.
