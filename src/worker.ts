import baseHandler, { type Env } from "./index";

type VideoFrame = { timestampSeconds: number; dataURL: string };
type VideoDrill = { id: string; name: string; goals?: string[]; cues?: string[] };
type VideoReviewBody = {
  discipline?: unknown;
  focus?: unknown;
  focuses?: unknown;
  experience?: unknown;
  frames?: unknown;
  drills?: unknown;
  previous?: unknown;
};

const OPENAI_VISION_MODEL = "gpt-6-luna";
const RETRYABLE_VIDEO_STATUSES = new Set([429, 502, 503, 504]);
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanJSONText(value: string): string {
  const withoutFences = value
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const firstBrace = withoutFences.indexOf("{");
  const lastBrace = withoutFences.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) return withoutFences;
  return withoutFences.slice(firstBrace, lastBrace + 1);
}

function extractOpenAIText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return "";
  const pieces: string[] = [];
  for (const item of data.output) {
    if (!Array.isArray(item?.content)) continue;
    for (const part of item.content) {
      if ((part?.type === "output_text" || part?.type === "text") && typeof part?.text === "string") {
        pieces.push(part.text);
      }
    }
  }
  return pieces.join("\n").trim();
}

function parseFallbackBody(raw: VideoReviewBody): {
  discipline: string;
  experience: string;
  focuses: string[];
  frames: VideoFrame[];
  drills: VideoDrill[];
  previous: string;
} | null {
  const discipline = typeof raw.discipline === "string" ? raw.discipline.trim().slice(0, 80) : "";
  const experience = typeof raw.experience === "string" ? raw.experience.trim().slice(0, 80) : "";
  const legacyFocus = typeof raw.focus === "string" ? raw.focus : "";
  const focuses = Array.isArray(raw.focuses)
    ? raw.focuses.filter((v): v is string => typeof v === "string").map((v) => v.trim().slice(0, 80)).filter(Boolean).slice(0, 7)
    : legacyFocus.split(",").map((v) => v.trim().slice(0, 80)).filter(Boolean).slice(0, 7);

  if (!Array.isArray(raw.frames) || raw.frames.length === 0 || raw.frames.length > 10) return null;
  const frames: VideoFrame[] = [];
  for (const item of raw.frames) {
    if (!item || typeof item !== "object") return null;
    const frame = item as Record<string, unknown>;
    if (typeof frame.timestampSeconds !== "number" || !Number.isFinite(frame.timestampSeconds)) return null;
    if (typeof frame.dataURL !== "string" || !frame.dataURL.startsWith("data:image/jpeg;base64,")) return null;
    frames.push({ timestampSeconds: frame.timestampSeconds, dataURL: frame.dataURL });
  }

  const drills: VideoDrill[] = Array.isArray(raw.drills)
    ? raw.drills.slice(0, 20).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const drill = item as Record<string, unknown>;
        if (typeof drill.id !== "string" || typeof drill.name !== "string") return [];
        return [{
          id: drill.id.slice(0, 160),
          name: drill.name.slice(0, 160),
          goals: Array.isArray(drill.goals) ? drill.goals.filter((v): v is string => typeof v === "string").slice(0, 8) : [],
          cues: Array.isArray(drill.cues) ? drill.cues.filter((v): v is string => typeof v === "string").slice(0, 4) : [],
        }];
      })
    : [];

  const previous = raw.previous && typeof raw.previous === "object"
    ? JSON.stringify(raw.previous).slice(0, 3000)
    : "None";

  if (!discipline || focuses.length === 0) return null;
  return { discipline, experience, focuses, frames, drills, previous };
}

function normalizeFallbackReview(parsed: any, drills: VideoDrill[]) {
  const clamp = (value: unknown): number | null => {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.min(98, Math.max(0, Math.round(value)));
  };

  const categories = Array.isArray(parsed?.categories)
    ? parsed.categories.slice(0, 10).flatMap((item: any) => {
        if (!item || typeof item.category !== "string") return [];
        return [{ category: item.category.trim().slice(0, 80), score: clamp(item.score) }];
      })
    : [];
  const scored = categories.filter((item: { score: number | null }) => item.score !== null);
  let overallScore = clamp(parsed?.overallScore ?? parsed?.overall ?? parsed?.score);
  if (overallScore === null && scored.length > 0) {
    overallScore = Math.round(scored.reduce((sum: number, item: { score: number | null }) => sum + (item.score ?? 0), 0) / scored.length);
  }

  const strength = typeof parsed?.strength === "string" ? parsed.strength.trim() : "";
  const corrections = Array.isArray(parsed?.corrections)
    ? parsed.corrections.filter((v: unknown): v is string => typeof v === "string").map((v: string) => v.trim()).filter(Boolean).slice(0, 3)
    : [];
  const nextStep = typeof parsed?.nextStep === "string" ? parsed.nextStep.trim() : "";
  const validDrillIDs = new Set(drills.map((drill) => drill.id));
  const recommendedDrillID = typeof parsed?.recommendedDrillID === "string" && validDrillIDs.has(parsed.recommendedDrillID)
    ? parsed.recommendedDrillID
    : null;

  if (overallScore === null || scored.length === 0 || !strength || corrections.length === 0 || !nextStep) return null;
  return { overallScore, categories, strength, corrections, nextStep, recommendedDrillID };
}

async function callOpenAIVisionFallback(request: Request, env: Env): Promise<Response> {
  if (!env.OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: { code: "video_ai_upstream_error", message: "Coach couldn't reach the vision service for this review. Try again shortly." } }), {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json", "X-Kazushiki-Video-Provider": "none" },
    });
  }

  let rawBody: VideoReviewBody;
  try {
    rawBody = await request.json() as VideoReviewBody;
  } catch {
    return new Response(JSON.stringify({ error: { code: "invalid_json", message: "Request body must be JSON." } }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const body = parseFallbackBody(rawBody);
  if (!body) {
    return new Response(JSON.stringify({ error: { code: "invalid_video_review", message: "Provide discipline, focus, and valid sampled frames." } }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const isOverall = body.focuses.some((value) => value.toLowerCase() === "overall");
  const focusLabel = isOverall ? "Overall" : body.focuses.join(", ");
  const drillList = body.drills.slice(0, 8).map((drill) => `- ${drill.name} [${drill.id}]: ${(drill.cues?.[0] ?? "").slice(0, 90)}`).join("\n");
  const categoryInstruction = isOverall
    ? "Choose 4-7 categories supported by the frames; use null for anything unclear."
    : `Return every requested category in this order: ${body.focuses.join(", ")}. Use score null when the frames cannot support a score.`;

  const instructions = `You are Kazushiki Combat's emergency video-review coach. Analyze chronological still frames sampled from one 10-30 second striking clip. Judge ONLY what is visible. These are sampled stills, not full-motion video; do not claim to measure speed, force, conditioning, or reaction time unless clearly supported.\n\nSTYLE: ${body.discipline}\nFOCUS: ${focusLabel}\nLEVEL: ${body.experience || "Not set"}\n\nReturn ONLY one compact JSON object with exactly these top-level keys: strength, corrections, nextStep, categories, overallScore, recommendedDrillID. strength is one concrete visible strength. corrections is 1-3 actionable visible corrections. nextStep is one encouraging specific drill/action. categories is an array of {category, score}; scores are integers 0-98 or null. ${categoryInstruction} overallScore is an integer 0-98 based only on visible scored categories. recommendedDrillID must be an exact ID from the supplied list or null. No markdown. No profanity. Do not diagnose injuries.\n\nPREVIOUS: ${body.previous}\nDRILLS:\n${drillList || "No matching in-app drills supplied."}`;

  const content: any[] = [{ type: "input_text", text: "Review these chronological frames from the same striking clip. Timestamps show position in the clip." }];
  for (const frame of body.frames) {
    content.push({ type: "input_text", text: `Frame at ${frame.timestampSeconds.toFixed(2)} seconds` });
    content.push({ type: "input_image", image_url: frame.dataURL, detail: "low" });
  }

  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_VISION_MODEL,
        instructions,
        input: [{ role: "user", content }],
        max_output_tokens: 1800,
      }),
    });

    const rawText = await upstream.text();
    let data: any = null;
    try { data = JSON.parse(rawText); } catch {}
    if (!upstream.ok) {
      console.error("OpenAI vision fallback error", upstream.status, data?.error?.code ?? data?.error?.type ?? "", data?.error?.message ?? rawText.slice(0, 500));
      throw new Error(`OpenAI vision fallback returned ${upstream.status}`);
    }

    const text = extractOpenAIText(data);
    const parsed = JSON.parse(cleanJSONText(text));
    const normalized = normalizeFallbackReview(parsed, body.drills);
    if (!normalized) throw new Error("OpenAI vision fallback returned an incomplete review");

    console.log("Video review completed through OpenAI fallback", { frameCount: body.frames.length, model: data?.model ?? OPENAI_VISION_MODEL });
    return new Response(JSON.stringify(normalized), {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "application/json",
        "X-Kazushiki-Video-Provider": "openai-fallback",
      },
    });
  } catch (error) {
    console.error("OpenAI vision fallback failed", String((error as Error)?.message ?? error));
    return new Response(JSON.stringify({ error: { code: "video_ai_upstream_error", message: "Coach couldn't reach the vision service for this review. Try again shortly." } }), {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json", "X-Kazushiki-Video-Provider": "failed" },
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ai/video-review" || request.method !== "POST") {
      return (baseHandler as any).fetch(request, env, ctx);
    }

    // First attempt uses the normal Gemini 3.8 -> Gemini 3.6 chain in index.ts.
    const first = await (baseHandler as any).fetch(request.clone(), env, ctx) as Response;
    if (!RETRYABLE_VIDEO_STATUSES.has(first.status)) return first;

    // Temporary provider overloads are common. Retry the full Gemini chain once
    // after a short jittered delay before crossing providers.
    const retryDelayMs = 900 + Math.floor(Math.random() * 350);
    console.warn("Video review temporary failure; retrying Gemini chain", { status: first.status, retryDelayMs });
    await sleep(retryDelayMs);

    const second = await (baseHandler as any).fetch(request.clone(), env, ctx) as Response;
    if (!RETRYABLE_VIDEO_STATUSES.has(second.status)) return second;

    console.warn("Gemini retry exhausted; switching to OpenAI vision fallback", { status: second.status });
    return callOpenAIVisionFallback(request.clone(), env);
  },
} satisfies ExportedHandler<Env>;
