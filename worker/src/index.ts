import Anthropic from "@anthropic-ai/sdk";
import {
  DRY_AGATE_REFERENCE_BASE64,
  DRY_AGATE_REFERENCE_CAPTION,
  DRY_AGATE_REFERENCE_MEDIA_TYPE,
} from "./referenceImages";

export interface Env {
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGIN?: string;
}

const MODEL = "claude-haiku-4-5";
const MAX_BASE64_LENGTH = 8 * 1024 * 1024; // ~6MB of raw image data, base64-inflated

const ALLOWED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function criterionSchema() {
  return {
    type: "object",
    properties: {
      rating: { type: "string", enum: ["yes", "maybe", "no"] },
      explanation: { type: "string" },
    },
    required: ["rating", "explanation"],
    additionalProperties: false,
  };
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    contains_agate: { type: "boolean" },
    confidence: { type: "number" },
    verdict: { type: "string", enum: ["likely", "possible", "unlikely"] },
    summary: { type: "string" },
    region: {
      type: "object",
      properties: {
        present: { type: "boolean" },
        location_description: { type: "string" },
        x_min: { type: "number" },
        y_min: { type: "number" },
        x_max: { type: "number" },
        y_max: { type: "number" },
      },
      required: ["present", "location_description", "x_min", "y_min", "x_max", "y_max"],
      additionalProperties: false,
    },
    criteria: {
      type: "object",
      properties: {
        banding: criterionSchema(),
        color_palette: criterionSchema(),
        translucency_luster: criterionSchema(),
        shape_texture: criterionSchema(),
      },
      required: ["banding", "color_palette", "translucency_luster", "shape_texture"],
      additionalProperties: false,
    },
  },
  required: ["contains_agate", "confidence", "verdict", "summary", "region", "criteria"],
  additionalProperties: false,
} as const;

function buildPrompt(width: number | undefined, height: number | undefined): string {
  const dimensionLine =
    width && height
      ? `This photo is ${width} x ${height} pixels.`
      : `The exact pixel dimensions of this photo were not provided -- reason in fractions of the image's width and height regardless.`;

  return `You are an expert rockhound helping identify Lake Superior agates from photos. Lake Superior agates are banded chalcedony (a form of quartz) found in the Lake Superior watershed (Minnesota's North Shore, Wisconsin, Michigan's Upper Peninsula, Ontario). Genuine ones typically show:

1. Banding: parallel or concentric bands (straight, wavy, or "eyed") that wrap around each other like tree rings.
2. Color palette: red, orange, or rust bands (iron oxide) alternating with cream, white, or gray bands.
3. Translucency & luster: a smooth, waxy-to-glassy surface; thin edges may glow when backlit or wet.
4. Shape & texture: usually a smooth, rounded pebble or cobble (glacier- and wave-tumbled), not a sharp freshly-broken chunk.

IMPORTANT -- most photos show a DRY rock, and dry agates look much subtler than wet ones. Do not require vivid, saturated color contrast or an obvious glassy shine before saying yes. On a dry agate, look instead for:
- A pitted, dimpled "orange-peel" texture on the rind -- small, shallow pits covering the surface, distinct from the smooth or rough texture of ordinary dry rocks.
- A faint waxy or soapy-looking sheen where the light catches the surface, even if the rest of the rock looks matte and dusty.
- Muted, chalky versions of the banding colors (dusty rust, faded cream) rather than bright red/orange -- the band PATTERN (parallel or concentric lines) matters more than how saturated the colors look when dry.
- Any chipped, broken, or worn-through spot on the rock -- these often reveal truer color and a glossier texture than the weathered exterior, even in an otherwise dull-looking dry rock.
A dry agate can look almost like a plain gray or tan pebble at first glance; look closely for these subtler cues before ruling it out.

Look at the attached photo of a rock. ${dimensionLine} It may be sitting on dirt, gravel, sand, grass, in a hand, etc. -- ignore the background and focus only on the rock itself.

To locate the most agate-like part of the rock, work through these steps explicitly:
1. Mentally overlay a 10x10 grid on the photo: column 0 and row 0 are the top-left corner, column 9 and row 9 are the bottom-right corner.
2. Scan the rock's surface and identify which grid cell(s) show the strongest banding, color contrast, or glassy highlight.
3. In location_description, describe that spot in plain words relative to the whole photo before giving any numbers (e.g. "in the upper-right quadrant of the rock, just left of center" or "along the bottom edge of the rock, slightly right of center").
4. Convert that description into a tight bounding box around just that patch (not the whole rock): x_min/y_min is its top-left corner and x_max/y_max is its bottom-right corner, each as a fraction of the image's full width/height, where 0.0 is the left/top edge and 1.0 is the right/bottom edge.

If you don't see a convincing agate region anywhere on the rock, still return your best-guess bounding box around the rock itself (or the most rock-like part of the photo), but set region.present to false.

Then determine:
- Whether the rock shows convincing agate banding and color characteristics, or is more likely a plain or different type of rock (solid-colored stone, basalt, granite, unbanded jasper, quartz, etc).
- A one-paragraph, plain-language summary explaining your verdict for a hobbyist.
- A rating ("yes", "maybe", or "no") plus a one-sentence explanation for each of these four criteria as observed in THIS photo: banding, color_palette, translucency_luster, shape_texture.
- An overall confidence score from 0.0 to 1.0, and a verdict of "likely", "possible", or "unlikely".

Be honest and calibrated -- most rocks people photograph are not agates, and photos are often blurry, dim, or show the rock dry (agate banding is much more visible wet or in direct sun). If the image doesn't clearly show a rock at all, set contains_agate to false, verdict to "unlikely", region.present to false, and explain why in summary.`;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

interface RequestBody {
  imageBase64?: string;
  mediaType?: string;
  width?: number;
  height?: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, origin);
    }

    let body: RequestBody;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
    }

    const { imageBase64, mediaType, width, height } = body;
    if (!imageBase64 || !mediaType) {
      return jsonResponse({ error: "Missing imageBase64 or mediaType" }, 400, origin);
    }
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      return jsonResponse({ error: `Unsupported mediaType: ${mediaType}` }, 400, origin);
    }
    if (imageBase64.length > MAX_BASE64_LENGTH) {
      return jsonResponse({ error: "Image too large" }, 413, origin);
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        output_config: { format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Reference photo (for calibration only -- do not analyze or score this image itself):",
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: DRY_AGATE_REFERENCE_MEDIA_TYPE,
                  data: DRY_AGATE_REFERENCE_BASE64,
                },
              },
              { type: "text", text: DRY_AGATE_REFERENCE_CAPTION },
              {
                type: "text",
                text: "Now here is the actual rock to evaluate -- base your analysis only on this photo below:",
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                  data: imageBase64,
                },
              },
              { type: "text", text: buildPrompt(width, height) },
            ],
          },
        ],
      });

      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === "text"
      );
      if (!textBlock) {
        return jsonResponse({ error: "No text response from model" }, 502, origin);
      }

      const result = JSON.parse(textBlock.text);
      return jsonResponse(result, 200, origin);
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: "Vision analysis failed", detail: message }, 502, origin);
    }
  },
};
