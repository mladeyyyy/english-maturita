// Cloudflare Pages: stránky + AI prostředník v jednom. Klíč je tajná proměnná GEMINI_API_KEY.
const MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/api") return env.ASSETS.fetch(req); // běžné stránky (index.html)

    const out = (o, s = 200) =>
      new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    if (req.method !== "POST") return out({ error: "POST only" }, 405);

    let prompt = "";
    try { prompt = (await req.json()).prompt; } catch (e) {}
    if (typeof prompt !== "string" || !prompt || prompt.length > 12000) return out({ error: "Bad prompt" }, 400);

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 2000, temperature: 0.7 },
    });
    let last = "AI chyba";
    for (const m of MODELS) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body,
      });
      if (r.ok) {
        const j = await r.json();
        return out({ text: (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("") });
      }
      last = "AI chyba (" + r.status + ")";
      if (![400, 403, 404].includes(r.status)) break;
    }
    return out({ error: last }, 502);
  },
};
