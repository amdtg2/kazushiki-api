export interface Env {
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

type ChatRole = "system" | "user" | "assistant";
type ChatMessage = { role: ChatRole; content: string };
type ChatRequestBody = {
  messages?: unknown;
  system?: unknown;
  stream?: unknown;
  temperature?: unknown;
  maxTokens?: unknown;
};

type VideoFrame = { timestampSeconds: number; dataURL: string };
type VideoDrill = { id: string; name: string; goals: string[]; cues: string[] };
type VideoReviewRequestBody = {
  discipline?: unknown;
  focus?: unknown;
  focuses?: unknown;
  experience?: unknown;
  frames?: unknown;
  drills?: unknown;
  previous?: unknown;
};

const BACKEND_VERSION = "kc-direct-2026-10-04.1";
const CHAT_MODEL = "gpt-6-luna";
const VIDEO_MODEL = "gemini-3.8-flash";
const VIDEO_FALLBACK_MODEL = "gemini-3.6-flash";
const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 8000;
const MAX_VIDEO_FRAMES = 10;
const MAX_FRAME_CHARS = 1_500_000;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      "X-KC-Backend-Version": BACKEND_VERSION,
      "X-Kazushiki-Backend": "cloudflare-direct",
    },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function parseMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const allowed: ChatRole[] = ["system", "user", "assistant"];
  const parsed: ChatMessage[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const { role, content } = item as { role?: unknown; content?: unknown };
    const normalizedRole = role === "coach" ? "assistant" : role;
    if (
      typeof normalizedRole !== "string" ||
      !allowed.includes(normalizedRole as ChatRole) ||
      typeof content !== "string"
    ) return null;

    const trimmed = content.trim();
    if (!trimmed) continue;
    parsed.push({ role: normalizedRole as ChatRole, content: trimmed.slice(0, MAX_CONTENT_CHARS) });
  }

  return parsed.slice(-MAX_MESSAGES);
}

function parseVideoFrames(raw: unknown): VideoFrame[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_VIDEO_FRAMES) return null;
  const frames: VideoFrame[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const { timestampSeconds, dataURL } = item as { timestampSeconds?: unknown; dataURL?: unknown };
    if (typeof timestampSeconds !== "number" || !Number.isFinite(timestampSeconds)) return null;
    if (
      typeof dataURL !== "string" ||
      !dataURL.startsWith("data:image/jpeg;base64,") ||
      dataURL.length > MAX_FRAME_CHARS
    ) return null;
    frames.push({ timestampSeconds, dataURL });
  }

  return frames;
}

function parseVideoDrills(raw: unknown): VideoDrill[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const { id, name, goals, cues } = item as {
      id?: unknown; name?: unknown; goals?: unknown; cues?: unknown;
    };
    if (typeof id !== "string" || typeof name !== "string") return [];
    return [{
      id: id.slice(0, 160),
      name: name.slice(0, 160),
      goals: Array.isArray(goals) ? goals.filter((v): v is string => typeof v === "string").slice(0, 8) : [],
      cues: Array.isArray(cues) ? cues.filter((v): v is string => typeof v === "string").slice(0, 4) : [],
    }];
  });
}

function extractOpenAIText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
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

async function callOpenAIText(
  env: Env,
  options: { instructions?: string; messages: ChatMessage[]; maxOutputTokens: number }
): Promise<{ text: string; model: string }> {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      instructions: options.instructions || undefined,
      input: options.messages.map((message) => ({ role: message.role, content: message.content })),
      max_output_tokens: options.maxOutputTokens,
    }),
  });

  const rawText = await upstream.text();
  let data: any = null;
  try { data = JSON.parse(rawText); } catch {}

  if (!upstream.ok) {
    const providerCode = data?.error?.code ?? data?.error?.type ?? "";
    const detail = typeof data?.error?.message === "string" ? data.error.message.slice(0, 500) : rawText.slice(0, 500);
    console.error("OpenAI upstream error", upstream.status, providerCode, detail);
    const error = new Error(detail || `OpenAI returned ${upstream.status}`) as Error & { status?: number; providerCode?: string };
    error.status = upstream.status;
    error.providerCode = String(providerCode);
    throw error;
  }

  const text = extractOpenAIText(data);
  if (!text) throw new Error("OpenAI returned an empty response");
  return { text, model: typeof data?.model === "string" ? data.model : CHAT_MODEL };
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  if (!env.OPENAI_API_KEY) return errorResponse(503, "ai_unavailable", "AI Coach is not configured yet.");

  let body: ChatRequestBody;
  try { body = (await request.json()) as ChatRequestBody; }
  catch { return errorResponse(400, "invalid_json", "Request body must be JSON."); }

  const messages = parseMessages(body.messages);
  if (!messages || messages.length === 0) {
    return errorResponse(400, "invalid_messages", "Provide a non-empty messages array of { role, content }.");
  }

  const system = typeof body.system === "string" ? body.system.trim().slice(0, MAX_CONTENT_CHARS) : "";
  const history = messages.filter((message) => message.role !== "system");
  const maxOutputTokens = typeof body.maxTokens === "number" && Number.isFinite(body.maxTokens)
    ? Math.min(Math.max(Math.round(body.maxTokens), 16), 4000)
    : 190;

  try {
    const result = await callOpenAIText(env, { instructions: system, messages: history, maxOutputTokens });
    return json({ reply: result.text, model: result.model });
  } catch (error) {
    const providerError = error as Error & { status?: number; providerCode?: string };
    if (
      providerError.status === 429 &&
      /insufficient_quota|billing|quota/i.test(`${providerError.providerCode ?? ""} ${providerError.message}`)
    ) return errorResponse(402, "credits_exhausted", "AI Coach usage credits are unavailable right now.");
    if (providerError.status === 429) return errorResponse(429, "rate_limited", "AI Coach is busy right now. Wait a moment and try again.");
    console.error("AI chat request failed", String(providerError.message ?? error));
    return errorResponse(502, "ai_upstream_error", "The AI coach is unavailable right now. Try again shortly.");
  }
}

function cleanJSONText(value: string): string {
  const withoutFences = value.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const firstBrace = withoutFences.indexOf("{");
  const lastBrace = withoutFences.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) return withoutFences;
  return withoutFences.slice(firstBrace, lastBrace + 1);
}

async function repairVideoReviewJSON(raw: string, env: Env): Promise<any | null> {
  try {
    const result = await callOpenAIText(env, {
      instructions: "Convert the user's malformed JSON-like video review into one valid JSON object. Preserve the same meaning and keys. Do not add commentary, markdown, or code fences. Return JSON only.",
      messages: [{ role: "user", content: raw.slice(0, 12000) }],
      maxOutputTokens: 1000,
    });
    return JSON.parse(cleanJSONText(result.text));
  } catch (error) {
    console.error("Video review JSON repair failed", String(error));
    return null;
  }
}

function clampScore(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(98, Math.max(0, Math.round(value)));
}

function dataURLToBase64(dataURL: string): string {
  const comma = dataURL.indexOf(",");
  return comma >= 0 ? dataURL.slice(comma + 1) : dataURL;
}

async function callGeminiVideo(
  env: Env,
  model: string,
  system: string,
  frames: VideoFrame[]
): Promise<{ raw: string; finishReason: string; outputTokens: number | null }> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");

  const parts: any[] = [{
    text: "Review these chronological frames from the same striking clip. Timestamps show position in the clip.",
  }];
  for (const frame of frames) {
    parts.push({ text: `Frame at ${frame.timestampSeconds.toFixed(2)} seconds` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: dataURLToBase64(frame.dataURL) } });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 3400,
        responseMimeType: "application/json",
      },
    }),
  });

  const rawText = await upstream.text();
  let data: any = null;
  try { data = JSON.parse(rawText); } catch {}

  if (!upstream.ok) {
    const detail = typeof data?.error?.message === "string" ? data.error.message.slice(0, 700) : rawText.slice(0, 700);
    console.error("Gemini upstream error", model, upstream.status, detail);
    const error = new Error(detail || `Gemini returned ${upstream.status}`) as Error & { status?: number };
    error.status = upstream.status;
    throw error;
  }

  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const raw = Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts.map((part: any) => typeof part?.text === "string" ? part.text : "").join("").trim()
    : "";

  return {
    raw,
    finishReason: typeof candidate?.finishReason === "string" ? candidate.finishReason : "UNKNOWN",
    outputTokens: typeof data?.usageMetadata?.candidatesTokenCount === "number" ? data.usageMetadata.candidatesTokenCount : null,
  };
}

async function generateVideoReview(env: Env, system: string, frames: VideoFrame[]) {
  try {
    const primary = await callGeminiVideo(env, VIDEO_MODEL, system, frames);
    return { ...primary, model: VIDEO_MODEL };
  } catch (error) {
    const primaryError = error as Error & { status?: number };
    const shouldFallback = primaryError.status === 404 || primaryError.status === 429 || (typeof primaryError.status === "number" && primaryError.status >= 500);
    if (!shouldFallback) throw error;
    console.warn("Primary Gemini video model failed; trying fallback", primaryError.status ?? "unknown");
    const fallback = await callGeminiVideo(env, VIDEO_FALLBACK_MODEL, system, frames);
    return { ...fallback, model: VIDEO_FALLBACK_MODEL };
  }
}

async function handleVideoReview(request: Request, env: Env): Promise<Response> {
  if (!env.GEMINI_API_KEY) return errorResponse(503, "ai_unavailable", "Video review is not configured yet.");

  let body: VideoReviewRequestBody;
  try { body = (await request.json()) as VideoReviewRequestBody; }
  catch { return errorResponse(400, "invalid_json", "Request body must be JSON."); }

  const discipline = typeof body.discipline === "string" ? body.discipline.slice(0, 80) : "";
  const legacyFocus = typeof body.focus === "string" ? body.focus.slice(0, 240) : "";
  const experience = typeof body.experience === "string" ? body.experience.slice(0, 80) : "";
  const frames = parseVideoFrames(body.frames);
  const drills = parseVideoDrills(body.drills);
  const requestedFocuses = Array.isArray(body.focuses)
    ? body.focuses.filter((v): v is string => typeof v === "string").map((v) => v.trim().slice(0, 80)).filter(Boolean).slice(0, 7)
    : legacyFocus.split(",").map((v) => v.trim()).filter(Boolean).slice(0, 7);

  if (!discipline || requestedFocuses.length === 0 || !frames) {
    return errorResponse(400, "invalid_video_review", "Provide discipline, focus, and valid sampled frames.");
  }

  const isOverall = requestedFocuses.some((value) => value.toLowerCase() === "overall");
  const focusLabel = isOverall ? "Overall" : requestedFocuses.join(", ");
  const previous = typeof body.previous === "object" && body.previous !== null ? JSON.stringify(body.previous).slice(0, 3000) : "None";
  const categoryInstruction = isOverall
    ? "Choose 4-7 categories supported by the frames; use null for anything unclear."
    : `Return all requested categories in this order: ${requestedFocuses.join(", ")}. Use score: null for any category the frames cannot support. Do not add unrelated categories.`;
  const conciseDrillList = drills.slice(0, 8).map((drill) => `- ${drill.name} [${drill.id}]: ${(drill.cues[0] ?? "").slice(0, 90)}`).join("\n");

  const system = `
You are Kazushiki Combat's video coach. Analyze chronological still frames sampled from a single 10-30 second striking clip. A side or cropped view is valid. Judge ONLY what is visible; ignore setup/ending frames. These are sampled stills, not full-motion video: don't claim to measure reaction time, strike speed, impact force, or conditioning from them.

STYLE: ${discipline}
FOCUS: ${focusLabel}
LEVEL: ${experience || "Not set"}

Write the feedback FIRST, then numerical scores. Answer with ONLY a compact valid JSON object, no markdown and no extra explanations. Use this EXACT key order:
{"strength":"One concrete visible strength (max 22 words).","corrections":["One actionable visible correction (max 24 words).","Optional second correction (max 24 words)."],"nextStep":"One specific encouraging next step (max 25 words).","categories":[{"category":"Technique","score":76}],"overallScore":74,"recommendedDrillID":null}

RULES
- Strength, 1-3 corrections, and nextStep are REQUIRED; no generic filler.
- ${categoryInstruction}
- Scores must be honest integers from 0 to 98 or null for categories not visibly assessable. Do not invent scores.
- Only score what the sampled frames support. Power Mechanics refers only to visible mechanics, not measured power. Reactions need a visible cue; otherwise null. Never score conditioning or confidence.
- For a custom focus selection, Overall summarizes only visible selected categories. Scores can go down in later reviews.
- Use the positive sandwich: visible strength -> biggest 1-3 fixes -> encouraging practical drill/next step.
- No profanity. Do not diagnose injuries.
- recommendedDrillID may ONLY be an exact ID from the drill list below. Otherwise use null.
- Finish ALL JSON fields before stopping; be concise and spend no output on reasoning.

PREVIOUS: ${previous}
DRILLS:
${conciseDrillList || "No matching in-app drills supplied."}
`.trim();

  let completion: Awaited<ReturnType<typeof generateVideoReview>>;
  try {
    completion = await generateVideoReview(env, system, frames);
  } catch (error) {
    const providerError = error as Error & { status?: number };
    if (providerError.status === 429) return errorResponse(429, "rate_limited", "Video review is busy right now. Wait a moment and try again.");
    console.error("Video review provider request failed", String(providerError.message ?? error));
    return errorResponse(502, "video_ai_upstream_error", "Coach couldn't reach the vision service for this review. Try again shortly.");
  }

  const raw = completion.raw;
  const finishReason = completion.finishReason;
  console.log("Video review completion", {
    focusCount: requestedFocuses.length,
    model: completion.model,
    finishReason,
    outputTokens: completion.outputTokens,
    responseLength: raw.length,
  });

  if (/MAX_TOKENS|LENGTH/i.test(finishReason)) return errorResponse(422, "video_output_truncated", "Coach ran out of room to finish the review. Please try again.");
  if (!raw) return errorResponse(502, "empty_video_review", "Coach returned an empty video review.");

  let parsed: any;
  try { parsed = JSON.parse(cleanJSONText(raw)); }
  catch {
    console.warn("Video review JSON malformed; attempting formatting repair", { finishReason, responseLength: raw.length });
    parsed = await repairVideoReviewJSON(raw, env);
  }
  if (!parsed) return errorResponse(502, "invalid_video_review_json", "Coach couldn't format this review correctly. Try the clip again.");

  const nestedFeedback = [parsed?.feedback, parsed?.coaching, parsed?.coachFeedback, parsed?.summary, parsed?.positiveSandwich, parsed?.analysis, parsed?.review]
    .filter((value) => value && typeof value === "object");

  function readText(keys: string[]): string {
    for (const source of [parsed, ...nestedFeedback]) {
      for (const key of keys) {
        const value = source?.[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
    return "";
  }

  function readCorrections(): string[] {
    const candidates = [
      parsed?.corrections, parsed?.biggestFixes, parsed?.fixes,
      ...nestedFeedback.flatMap((source) => [source?.corrections, source?.biggestFixes, source?.fixes, source?.improvements]),
    ];
    for (const value of candidates) {
      if (Array.isArray(value)) {
        const cleaned = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 3);
        if (cleaned.length) return cleaned;
      }
      if (typeof value === "string" && value.trim()) return [value.trim()];
    }
    return [];
  }

  let categories: { category: string; score: number | null }[] = [];
  const readScore = (value: unknown): number | null => {
    const direct = clampScore(value);
    if (direct !== null) return direct;
    if (value && typeof value === "object") {
      const objectValue = value as Record<string, unknown>;
      return clampScore(objectValue.score ?? objectValue.rating ?? objectValue.value ?? objectValue.points);
    }
    return null;
  };

  if (Array.isArray(parsed?.categories)) {
    categories = parsed.categories.slice(0, 10).flatMap((category: any) => {
      if (!category || typeof category.category !== "string") return [];
      return [{ category: category.category.trim().slice(0, 80), score: readScore(category) }];
    });
  } else if (parsed?.categories && typeof parsed.categories === "object") {
    categories = Object.entries(parsed.categories).slice(0, 10).map(([category, value]) => ({ category: category.slice(0, 80), score: readScore(value) }));
  }

  for (const requested of requestedFocuses) {
    if (categories.some((item) => item.category.toLowerCase() === requested.toLowerCase())) continue;
    const topLevel = Object.entries(parsed ?? {}).find(([key]) => key.toLowerCase().replace(/[^a-z0-9]/g, "") === requested.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (topLevel) categories.push({ category: requested, score: readScore(topLevel[1]) });
  }

  if (!isOverall) {
    const byName = new Map(categories.map((item) => [item.category.toLowerCase(), item]));
    categories = requestedFocuses.map((requested) => {
      const exact = byName.get(requested.toLowerCase());
      if (exact) return { category: requested, score: exact.score };
      const fuzzy = categories.find((item) => item.category.toLowerCase().includes(requested.toLowerCase()) || requested.toLowerCase().includes(item.category.toLowerCase()));
      return { category: requested, score: fuzzy?.score ?? null };
    });
  }

  const scoredCategories = categories.filter((category) => category.score !== null);
  let overallScore = clampScore(parsed?.overallScore ?? parsed?.overall ?? parsed?.score);
  if (!isOverall && scoredCategories.length > 0) {
    overallScore = Math.round(scoredCategories.reduce((sum, category) => sum + (category.score ?? 0), 0) / scoredCategories.length);
  } else if (overallScore === null && scoredCategories.length > 0) {
    overallScore = Math.round(scoredCategories.reduce((sum, category) => sum + (category.score ?? 0), 0) / scoredCategories.length);
  }

  const strength = readText(["strength", "whatLookedGood", "what_looked_good", "positive", "praise"]);
  const corrections = readCorrections();
  const nextStep = readText(["nextStep", "next_step", "recommendation", "next", "actionStep"]);
  const validDrillIDs = new Set(drills.map((drill) => drill.id));
  const requestedDrillID = typeof parsed?.recommendedDrillID === "string" ? parsed.recommendedDrillID : null;
  const recommendedDrillID = requestedDrillID && validDrillIDs.has(requestedDrillID) ? requestedDrillID : null;

  if (overallScore === null || scoredCategories.length === 0 || !strength || corrections.length === 0 || !nextStep) {
    const missing = [
      overallScore === null ? "overall score" : "",
      scoredCategories.length === 0 ? "visible category scores" : "",
      !strength ? "specific strength" : "",
      corrections.length === 0 ? "actionable corrections" : "",
      !nextStep ? "next step" : "",
    ].filter(Boolean);
    return errorResponse(422, "insufficient_video_review", `Coach couldn't finish this review (missing: ${missing.join(", ")}). Choose a clearer angle or a narrower focus.`);
  }

  return json({ overallScore, categories, strength, corrections, nextStep, recommendedDrillID });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/" || url.pathname === "/ping" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "kazushiki-api",
        version: BACKEND_VERSION,
        aiConfigured: Boolean(env.OPENAI_API_KEY && env.GEMINI_API_KEY),
        chatConfigured: Boolean(env.OPENAI_API_KEY),
        videoConfigured: Boolean(env.GEMINI_API_KEY),
        now: new Date().toISOString(),
      });
    }

    if (url.pathname === "/ai/chat") {
      if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST.");
      return handleChat(request, env);
    }

    if (url.pathname === "/ai/video-review") {
      if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST.");
      return handleVideoReview(request, env);
    }

    return errorResponse(404, "not_found", "Route not found.");
  },
} satisfies ExportedHandler<Env>;
