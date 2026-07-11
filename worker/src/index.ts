import Anthropic from "@anthropic-ai/sdk";

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
        center_x: { type: "number" },
        center_y: { type: "number" },
        radius: { type: "number" },
      },
      required: ["present", "center_x", "center_y", "radius"],
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

const PROMPT = `You are an expert rockhound helping identify Lake Superior agates from photos. Lake Superior agates are banded chalcedony (a form of quartz) found in the Lake Superior watershed (Minnesota's North Shore, Wisconsin, Michigan's Upper Peninsula, Ontario). Genuine ones typically show:

1. Banding: parallel or concentric bands (straight, wavy, or "eyed") that wrap around each other like tree rings.
2. Color palette: red, orange, or rust bands (iron oxide) alternating with cream, white, or gray bands.
3. Translucency & luster: a smooth, waxy-to-glassy surface; thin edges may glow when backlit or wet.
4. Shape & texture: usually a smooth, rounded pebble or cobble (glacier- and wave-tumbled), not a sharp freshly-broken chunk.

Look at the attached photo of a rock. It may be sitting on dirt, gravel, sand, grass, in a hand, etc. -- ignore the background and focus only on the rock itself.

Determine:
- Whether the rock shows convincing agate banding and color characteristics, or is more likely a plain or different type of rock (solid-colored stone, basalt, granite, unbanded jasper, quartz, etc).
- If there is a promising region, its approximate location as a circle: center_x and center_y as fractions of the image width/height (0.0 = left/top edge, 1.0 = right/bottom edge), and radius as a fraction of the smaller of the image's width and height. Estimate this circle to tightly bound the most agate-like patch of the rock's surface. If you don't see a convincing agate region, still provide your best-guess region with region.present set to false, centered roughly on the rock itself.
- A one-paragraph, plain-language summary explaining your verdict for a hobbyist.
- A rating ("yes", "maybe", or "no") plus a one-sentence explanation for each of these four criteria as observed in THIS photo: banding, color_palette, translucency_luster, shape_texture.
- An overall confidence score from 0.0 to 1.0, and a verdict of "likely", "possible", or "unlikely".

Be honest and calibrated -- most rocks people photograph are not agates, and photos are often blurry, dim, or show the rock dry (agate banding is much more visible wet or in direct sun). If the image doesn't clearly show a rock at all, set contains_agate to false, verdict to "unlikely", region.present to false, and explain why in summary.`;

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

    const { imageBase64, mediaType } = body;
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
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                  data: imageBase64,
                },
              },
              { type: "text", text: PROMPT },
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
