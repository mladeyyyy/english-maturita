// Cloudflare Worker: stránky + AI prostředník (Gemini). Klíč je tajná proměnná GEMINI_API_KEY.
const API = "https://generativelanguage.googleapis.com/v1beta/";
const FULL = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-flash-latest"];
const FAST = ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash", "gemini-2.5-flash"];
const good = { fast: null, full: null }; // model, který naposledy fungoval

function cfg(model, max) {
  const c = { maxOutputTokens: max, temperature: 0.9 };
  if (/gemini-3/.test(model)) c.thinkingConfig = { thinkingLevel: "minimal" }; // bez dlouhého "přemýšlení"
  else if (/2\.5-flash/.test(model)) c.thinkingConfig = { thinkingBudget: 0 };
  return c;
}

async function gen(model, key, prompt, max, ms) {
  const call = async (withThink) => {
    const g = cfg(model, max);
    if (!withThink) delete g.thinkingConfig;
    const r = await fetch(API + "models/" + model + ":generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: g }),
      signal: AbortSignal.timeout(ms),
    });
    let j = {}; try { j = await r.json(); } catch (e) {}
    return { r, j };
  };
  let res;
  try {
    res = await call(true);
    if (res.r.status === 400) res = await call(false); // model nezná nastavení přemýšlení
  } catch (e) { return { ok: false, status: 0, text: "", why: "timeout/síť" }; }
  const { r, j } = res;
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  const why = j.error?.message || (j.candidates?.[0]?.finishReason ? "finish " + j.candidates[0].finishReason : "");
  return { ok: r.ok, status: r.status, text, why };
}

async function listFlash(key) {
  try {
    const r = await fetch(API + "models?pageSize=100", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace("models/", ""))
      .filter((n) => /flash/.test(n) && !/image|tts|live|audio|embed|exp|preview-\d/.test(n))
      .sort().reverse().slice(0, 4);
  } catch (e) { return []; }
}

async function run(env, prompt, fast, max) {
  if (!env.GEMINI_API_KEY) return { error: "Na serveru chybí GEMINI_API_KEY (Settings → Variables and Secrets)." };
  const mode = fast ? "fast" : "full", ms = fast ? 15000 : 40000, errs = [], tried = new Set();
  const attempt = async (m) => {
    tried.add(m);
    const r = await gen(m, env.GEMINI_API_KEY, prompt, max, ms);
    if (r.ok && r.text) { good[mode] = m; return { text: r.text, model: m }; }
    errs.push(m + ": " + r.status + " " + (r.why || "prázdná odpověď").slice(0, 140));
    return r.status === 429 || r.status === 401 || r.status === 403 ? { stop: true } : null;
  };
  if (good[mode]) { const x = await attempt(good[mode]); if (x && x.text) return x; if (x && x.stop) return { error: errs.join(" | ") }; }
  for (const m of fast ? FAST : FULL) { if (tried.has(m)) continue; const x = await attempt(m); if (x && x.text) return x; if (x && x.stop) return { error: errs.join(" | ") }; }
  for (const m of await listFlash(env.GEMINI_API_KEY)) { if (tried.has(m)) continue; const x = await attempt(m); if (x && x.text) return x; if (x && x.stop) break; }
  return { error: errs.join(" | ").slice(0, 500) };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/api") return env.ASSETS.fetch(req);
    const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

    if (req.method === "GET") { // diagnostika: otevři /api v prohlížeči
      const t = Date.now();
      const r = await run(env, "Reply with exactly: OK", true, 50);
      const ms = Date.now() - t;
      return out(r.text ? { ok: true, model: r.model, ms, reply: r.text } : { ok: false, ms, error: r.error }, r.text ? 200 : 502);
    }
    if (req.method !== "POST") return out({ error: "POST only" }, 405);
    let b = {}; try { b = await req.json(); } catch (e) {}
    const prompt = b.prompt;
    if (typeof prompt !== "string" || !prompt || prompt.length > 12000) return out({ error: "Bad prompt" }, 400);
    const max = Math.min(Math.max(parseInt(b.max) || 1500, 50), 3000);
    const r = await run(env, prompt, !!b.fast, max);
    return r.text ? out({ text: r.text }) : out({ error: r.error || "AI chyba" }, 502);
  },
};
