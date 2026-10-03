export interface Env {
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      "X-Kazushiki-Backend": "cloudflare",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/ping") {
      return json({
        ok: true,
        service: "kazushiki-api",
        aiConfigured: Boolean(env.OPENAI_API_KEY && env.GEMINI_API_KEY),
        now: new Date().toISOString(),
      });
    }

    if (url.pathname === "/ai/chat") {
      return json(
        { error: { code: "not_configured", message: "AI Coach migration is not configured yet." } },
        503
      );
    }

    if (url.pathname === "/ai/video-review") {
      return json(
        { error: { code: "not_configured", message: "Video review migration is not configured yet." } },
        503
      );
    }

    return json({ error: { code: "not_found", message: "Route not found." } }, 404);
  },
};
