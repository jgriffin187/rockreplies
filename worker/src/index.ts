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

function criteriaGroupSchema() {
  return {
    type: "object",
    properties: {
      banding: criterionSchema(),
      color_palette: criterionSchema(),
      translucency_luster: criterionSchema(),
      shape_texture: criterionSchema(),
    },
    required: ["banding", "color_palette", "translucency_luster", "shape_texture"],
    additionalProperties: false,
  };
}

// Note: there is deliberately no "confidence" or "verdict" field here -- the
// model was defaulting to the same vibe-y confidence number (e.g. "72%") on
// almost every photo regardless of content. Confidence is instead computed
// server-side (see computeConfidence/computeVerdict below) from these
// per-criterion ratings, which are grounded in what the model actually
// describes seeing rather than a free-floating guess.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          location_description: { type: "string" },
          x_min: { type: "number" },
          y_min: { type: "number" },
          x_max: { type: "number" },
          y_max: { type: "number" },
          criteria: criteriaGroupSchema(),
        },
        required: ["location_description", "x_min", "y_min", "x_max", "y_max", "criteria"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "candidates"],
  additionalProperties: false,
} as const;

const RATING_SCORE: Record<string, number> = { yes: 1, maybe: 0.5, no: 0 };
const CRITERIA_KEYS = ["banding", "color_palette", "translucency_luster", "shape_texture"] as const;

// Below this, a candidate isn't included in the response at all (not worth
// circling). At or above LIKELY_THRESHOLD, it's a strong match.
const INCLUDE_THRESHOLD = 0.375;
const LIKELY_THRESHOLD = 0.75;

interface Criterion {
  rating: string;
  explanation: string;
}

function computeConfidence(criteria: Record<string, Criterion>): number {
  const total = CRITERIA_KEYS.reduce((sum, key) => sum + (RATING_SCORE[criteria[key]?.rating] ?? 0), 0);
  return total / CRITERIA_KEYS.length;
}

function computeVerdict(confidence: number): "likely" | "possible" {
  return confidence >= LIKELY_THRESHOLD ? "likely" : "possible";
}

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

Look at the attached photo. ${dimensionLine} It may show ONE rock or SEVERAL rocks together (a handful, a pile, a few laid out side by side, etc). Ignore the background -- dirt, gravel, sand, grass, a hand, a table -- and evaluate only the rock(s).

For EACH distinct rock in the photo that shows plausible agate characteristics, add one entry to \`candidates\`. Skip any rock that clearly does not -- do not add an entry for every rock in the photo, only the ones worth a closer look. If a photo has one rock, this usually means 0 or 1 entries; if it has several rocks, it can mean anywhere from 0 up to however many actually look promising.

For each candidate rock, work through these steps explicitly:
1. Mentally overlay a 10x10 grid on the WHOLE photo: column 0 and row 0 are the top-left corner, column 9 and row 9 are the bottom-right corner.
2. Identify which grid cell(s) that specific rock occupies.
3. In location_description, describe where THAT ROCK is in plain words relative to the whole photo, before giving any numbers (e.g. "the smaller reddish rock in the bottom-left of the group" or "the only rock in the photo, filling most of the frame").
4. Give a tight bounding box around THAT ENTIRE ROCK (not just a patch of texture on it): x_min/y_min is its top-left corner and x_max/y_max is its bottom-right corner, each as a fraction of the image's full width/height, where 0.0 is the left/top edge and 1.0 is the right/bottom edge.
5. Rate each of these four criteria for that specific rock, each "yes"/"maybe"/"no" with a one-sentence explanation grounded in what you actually see on it: banding, color_palette, translucency_luster, shape_texture.

Also write \`summary\`: a plain-language paragraph covering the whole photo -- how many rocks you saw, how many (if any) looked promising and roughly why, or why none did.

Be honest and calibrated -- most rocks people photograph are not agates, and photos are often blurry, dim, or show the rock dry (agate banding is much more visible wet or in direct sun). If nothing in the photo looks like a plausible agate, return an empty \`candidates\` array and explain why in summary.`;
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

      const parsed = JSON.parse(textBlock.text) as {
        summary: string;
        candidates: Array<{
          location_description: string;
          x_min: number;
          y_min: number;
          x_max: number;
          y_max: number;
          criteria: Record<string, Criterion>;
        }>;
      };

      const candidates = parsed.candidates
        .map((c) => {
          const confidence = computeConfidence(c.criteria);
          return { ...c, confidence, verdict: computeVerdict(confidence) };
        })
        .filter((c) => c.confidence >= INCLUDE_THRESHOLD)
        .sort((a, b) => b.confidence - a.confidence);

      return jsonResponse({ summary: parsed.summary, candidates }, 200, origin);
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: "Vision analysis failed", detail: message }, 502, origin);
    }
  },
};
