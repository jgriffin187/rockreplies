# Agate Identifier — Vision Backend

A tiny Cloudflare Worker that receives a rock photo (base64) and asks Claude
(`claude-haiku-4-5`) whether it shows a Lake Superior agate, returning
structured JSON: verdict, confidence, a normalized circle (`center_x`,
`center_y`, `radius` as fractions of the image) marking the most agate-like
region, and a per-criterion breakdown (banding, color palette, translucency
& luster, shape & texture).

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

## Cost

`claude-haiku-4-5` pricing is $1/$5 per million input/output tokens. A
typical scan (one downsized photo + prompt + a short JSON response) costs
roughly $0.002–$0.004 (a fifth to a third of a cent). Cloudflare Workers'
free tier covers 100,000 requests/day, so hosting cost is $0.
