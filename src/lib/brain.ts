// Shared Acronous brain client for EquiVO.
//
// Talks to the hosted autonomous brain (acronous_llm service). The brain
// learns from every search query, every feed engagement, and every feedback
// signal we send, and it also keeps growing from the internet on its own.
//
// All calls are best-effort and fire-and-forget where possible so they never
// block the UI or break if the brain is unreachable.

// Brain base URL. Defaults to the Acronous AI domain; override via env in
// production builds.
const BRAIN_URL =
  import.meta.env.VITE_BRAIN_API_URL ||
  import.meta.env.VITE_AI_API_URL ||
  "https://ai.acronous.com";

const BRAIN_TIMEOUT = 4000;

async function brainFetch(path: string, body: unknown, opts: { method?: string; timeout?: number } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout ?? BRAIN_TIMEOUT);
  try {
    const resp = await fetch(`${BRAIN_URL}${path}`, {
      method: opts.method ?? "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── AI search suggestions (also teaches the brain the query) ────────────
export async function brainSearchSuggest(
  query: string,
  sessionId: string,
): Promise<string[]> {
  const data = await brainFetch("/v1/suggest/search", {
    query,
    session_id: sessionId,
    source: "equivo-search",
  });
  if (!data || !Array.isArray(data.suggestions)) return [];
  return data.suggestions.map((s: any) => (typeof s === "string" ? s : s?.label || "")).filter(Boolean);
}

// ── Feed suggestions / engagement learning ──────────────────────────────
export async function brainFeedSuggest(
  userId: string,
  interacted: string[],
): Promise<string[]> {
  const data = await brainFetch("/v1/suggest/feed", {
    user_id: userId,
    interacted,
    source: "equivo-feed",
  });
  if (!data || !Array.isArray(data.suggestions)) return [];
  return data.suggestions.filter((s: unknown): s is string => typeof s === "string");
}

// ── Explicit learning: teach the brain an interaction ───────────────────
export async function brainLearn(opts: {
  query: string;
  response?: string;
  routeType?: string;
  sessionId?: string;
  source?: string;
  feedback?: number;
}) {
  return brainFetch("/v1/learn", {
    query: opts.query,
    response: opts.response ?? "",
    route_type: opts.routeType ?? "general_chat",
    session_id: opts.sessionId ?? "default",
    source: opts.source ?? "equivo",
    feedback: opts.feedback ?? undefined,
  });
}

// ── Explicit feedback (thumbs up/down) ──────────────────────────────────
export async function brainFeedback(opts: {
  sessionId?: string;
  query: string;
  rating: number;
  response?: string;
  source?: string;
}) {
  return brainFetch("/v1/feedback", {
    session_id: opts.sessionId ?? "default",
    query: opts.query,
    rating: opts.rating,
    response: opts.response ?? "",
    source: opts.source ?? "equivo",
  });
}

// ── Generic AI generation (chat/assist) via the brain's LLM ─────────────
// Backed by /v1/generate on the brain service. Every call is also taught back
// to the brain so it learns from real usage.
export interface BrainGenerateOptions {
  prompt: string;
  system?: string;
  maxTokens?: number;
  sessionId?: string;
  source?: string;
  routeType?: string;
  temperature?: number;
}

export async function brainGenerate(opts: BrainGenerateOptions): Promise<string> {
  const data = await brainFetch("/v1/generate", {
    prompt: opts.prompt,
    system: opts.system ?? "",
    max_tokens: opts.maxTokens,
    session_id: opts.sessionId ?? "default",
    source: opts.source ?? "equivo",
    route_type: opts.routeType ?? "general_chat",
    temperature: opts.temperature,
  });
  if (!data || typeof data.response !== "string") return "";
  return data.response;
}

// ── Caption generation for uploaded media ───────────────────────────────
export async function brainGenerateCaptions(
  contentHint: string,
  sessionId?: string,
): Promise<string[]> {
  const prompt = `The user is posting on a social media app. Here is a short description of their content: "${contentHint}". Write 3 short, engaging, friendly captions (each under 120 characters, no hashtags). Return each caption on its own line.`;
  const raw = await brainGenerate({ prompt, sessionId, source: "equivo-caption", routeType: "image_generation" });
  return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s.length > 3).slice(0, 5);
}

// ── Hashtag / tag suggestions ───────────────────────────────────────────
export async function brainSuggestTags(
  content: string,
  sessionId?: string,
): Promise<string[]> {
  const prompt = `Suggest 8-10 relevant hashtags (words or short phrases WITHOUT the # symbol) for this social post: "${content}". Return ONLY the tags, separated by commas.`;
  const raw = await brainGenerate({ prompt, sessionId, source: "equivo-tags", routeType: "general_chat" });
  return raw
    .split(/[,;\n]/)
    .map((s) => s.replace(/#/g, "").trim())
    .filter((s) => s && s.length < 40)
    .slice(0, 10);
}

// ── Trending topics (real-time, learned from the internet) ──────────────
export async function brainTrendingTopics(sessionId?: string): Promise<{ name: string; posts: string; trend: "up" | "down" | "stable" }[]> {
  const data = await brainFetch("/v1/trending", {
    session_id: sessionId ?? "default",
    source: "equivo-trending",
  });
  if (!data || !Array.isArray(data.topics)) return [];
  return data.topics.filter((t: any) => t && typeof t.name === "string");
}

// ── AI chat assistant (for an AI contact in chat) ───────────────────────
export async function brainChat(
  message: string,
  history?: { role: "user" | "assistant"; content: string }[],
  sessionId?: string,
): Promise<string> {
  const data = await brainFetch("/v1/chat", {
    message,
    messages: history ?? [],
    session_id: sessionId ?? `equivo-ai-chat-${Date.now()}`,
    source: "equivo-chat",
  });
  if (!data || typeof data.response !== "string") return "";
  return data.response;
}

// ── Smart reply suggestions for user-to-user chat ───────────────────────
export async function brainSmartReplies(
  incomingMessage: string,
  sessionId?: string,
): Promise<string[]> {
  const prompt = `Suggest 3 short, natural, friendly reply options (under 40 characters each) to this message: "${incomingMessage}". Put each reply on its own line, no numbering.`;
  const raw = await brainGenerate({ prompt, sessionId, source: "equivo-smart-replies", routeType: "translation" });
  return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s.length < 45).slice(0, 3);
}

// ── Profile bio generation ──────────────────────────────────────────────
export async function brainGenerateBio(
  interests: string[],
  name: string,
  sessionId?: string,
): Promise<string[]> {
  const prompt = `Write 3 short, friendly social profile bios (under 80 characters each) for "${name}" whose interests include: ${interests.join(", ")}. Put each bio on its own line, no numbering.`;
  const raw = await brainGenerate({ prompt, sessionId, source: "equivo-bio", routeType: "general_chat" });
  return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s.length > 2).slice(0, 3);
}

// ── Content moderation / classification ─────────────────────────────────
export async function brainModerate(
  content: string,
  sessionId?: string,
): Promise<{ safe: boolean; categories: string[]; reason?: string }> {
  const prompt = `Classify this social media content for safety. Respond with a single JSON object: {"safe": true/false, "categories": ["..."]}. Categories: spam, harassment, hate, violence, inappropriate, misinformation, copyrighted, other, none. Content: "${content}". Reply with the JSON only.`;
  const raw = await brainGenerate({ prompt, sessionId, source: "equivo-moderation", routeType: "general_chat" });
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        safe: parsed.safe !== false,
        categories: Array.isArray(parsed.categories) ? parsed.categories : [],
        reason: parsed.reason,
      };
    }
  } catch {
    // fall through
  }
  return { safe: true, categories: [] };
}

// ── Topic suggestions for story/thought/moment creation ─────────────────
export async function brainTopicIdeas(
  kind: "story" | "thought" | "moment" | "poll" | "post",
  context?: string,
  sessionId?: string,
): Promise<string[]> {
  const prompt = `Suggest 4 creative ideas for a social media ${kind}${context ? ` about: "${context}"` : ""}. Each idea in one short sentence. Put each on its own line.`;
  const raw = await brainGenerate({ prompt, sessionId, source: "equivo-topic-ideas", routeType: "general_chat" });
  return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s.length > 5).slice(0, 4);
}

export { BRAIN_URL };
