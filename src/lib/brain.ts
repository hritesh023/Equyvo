// Recommendations client for Equyvo.
//
// All calls go to first-party /api routes on this app's own origin. The
// server forwards them where needed — the app never contacts any other host
// and never exposes how suggestions are produced. Every call is best-effort
// and fire-and-forget where possible so it never blocks the UI.

const API_TIMEOUT = 4000;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token = localStorage.getItem('equyvo_cognito_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const stored = localStorage.getItem('equyvo_cognito_user');
    if (stored) {
      const id = JSON.parse(stored)?.id;
      if (id) headers['X-User-Id'] = String(id);
    }
  } catch {
    /* ignore */
  }
  return headers;
}

async function apiFetch(path: string, body: unknown, opts: { method?: string; timeout?: number } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout ?? API_TIMEOUT);
  try {
    const resp = await fetch(path, {
      method: opts.method ?? 'POST',
      headers: authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
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

// ── Search suggestions (also teaches the service the query) ──────────────
export async function brainSearchSuggest(
  query: string,
  _sessionId: string,
): Promise<string[]> {
  const data = await apiFetch(`/api/suggest/search?q=${encodeURIComponent(query)}`, undefined, { method: 'GET' });
  const suggestions = data?.data?.suggestions;
  if (!Array.isArray(suggestions)) return [];
  return suggestions.map((s: any) => (typeof s === 'string' ? s : s?.label || '')).filter(Boolean);
}

// ── Feed suggestions ──────────────────────────────────────────────────────
export async function brainFeedSuggest(
  userId: string,
  _interacted: string[],
): Promise<string[]> {
  const data = await apiFetch(`/api/suggest/feed?userId=${encodeURIComponent(userId)}`, undefined, { method: 'GET' });
  const suggestions = data?.data?.suggestions;
  if (!Array.isArray(suggestions)) return [];
  return suggestions
    .map((s: unknown) => (typeof s === 'string' ? s : (s as { label?: string })?.label || ''))
    .filter(Boolean);
}

// ── Explicit learning: share an interaction signal ────────────────────────
export async function brainLearn(opts: {
  query: string;
  response?: string;
  routeType?: string;
  sessionId?: string;
  source?: string;
  feedback?: number;
}) {
  return apiFetch('/api/learn', {
    query: opts.query,
    response: opts.response ?? '',
    session_id: opts.sessionId ?? 'default',
    feedback: opts.feedback ?? undefined,
  });
}

// ── Explicit feedback (thumbs up/down) ────────────────────────────────────
export async function brainFeedback(opts: {
  sessionId?: string;
  query: string;
  rating: number;
  response?: string;
  source?: string;
}) {
  return apiFetch('/api/feedback', {
    session_id: opts.sessionId ?? 'default',
    query: opts.query,
    rating: opts.rating,
    response: opts.response ?? '',
  });
}

// ── Generic text generation (captions, ideas, replies) ────────────────────
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
  const data = await apiFetch('/api/generate', {
    prompt: opts.prompt,
    system: opts.system ?? '',
    session_id: opts.sessionId ?? 'default',
  });
  const response = data?.data?.response ?? data?.response;
  return typeof response === 'string' ? response : '';
}

// ── Caption suggestions for uploaded media ────────────────────────────────
export async function brainGenerateCaptions(
  contentHint: string,
  sessionId?: string,
): Promise<string[]> {
  const prompt = `The user is posting on a social media app. Here is a short description of their content: "${contentHint}". Write 3 short, engaging, friendly captions (each under 120 characters, no hashtags). Return each caption on its own line.`;
  const raw = await brainGenerate({ prompt, sessionId });
  return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s.length > 3).slice(0, 5);
}

// ── Hashtag / tag suggestions ─────────────────────────────────────────────
export async function brainSuggestTags(
  content: string,
  sessionId?: string,
): Promise<string[]> {
  const prompt = `Suggest 8-10 relevant hashtags (words or short phrases WITHOUT the # symbol) for this social post: "${content}". Return ONLY the tags, separated by commas.`;
  const raw = await brainGenerate({ prompt, sessionId });
  return raw
    .split(/[,;\n]/)
    .map((s) => s.replace(/#/g, '').trim())
    .filter((s) => s && s.length < 40)
    .slice(0, 10);
}

// ── Trending topics ───────────────────────────────────────────────────────
export async function brainTrendingTopics(): Promise<{ name: string; posts: string; trend: 'up' | 'down' | 'stable' }[]> {
  const data = await apiFetch('/api/trending/topics', undefined, { method: 'GET' });
  const topics = data?.data?.topics;
  if (!Array.isArray(topics)) return [];
  return topics.filter((t: any) => t && typeof t.name === 'string');
}

// ── Chat assistant ────────────────────────────────────────────────────────
export async function brainChat(
  message: string,
  history?: { role: 'user' | 'assistant'; content: string }[],
  sessionId?: string,
): Promise<string> {
  const data = await apiFetch('/api/chat', {
    message,
    messages: history ?? [],
    session_id: sessionId ?? `equivo-ai-chat-${Date.now()}`,
  });
  const response = data?.data?.response ?? data?.response;
  return typeof response === 'string' ? response : '';
}

// ── Smart reply suggestions for user-to-user chat ─────────────────────────
export async function brainSmartReplies(
  incomingMessage: string,
  sessionId?: string,
): Promise<string[]> {
  const prompt = `Suggest 3 short, natural, friendly reply options (under 40 characters each) to this message: "${incomingMessage}". Put each reply on its own line, no numbering.`;
  const raw = await brainGenerate({ prompt, sessionId });
  return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s.length < 45).slice(0, 3);
}

// ── Profile bio suggestions ───────────────────────────────────────────────
export async function brainGenerateBio(
  interests: string[],
  name: string,
  sessionId?: string,
): Promise<string[]> {
  const prompt = `Write 3 short, friendly social profile bios (under 80 characters each) for "${name}" whose interests include: ${interests.join(', ')}. Put each bio on its own line, no numbering.`;
  const raw = await brainGenerate({ prompt, sessionId });
  return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s.length > 2).slice(0, 3);
}

// ── Topic ideas for creation ──────────────────────────────────────────────
export async function brainTopicIdeas(
  kind: 'story' | 'thought' | 'moment' | 'poll' | 'post',
  context?: string,
  sessionId?: string,
): Promise<string[]> {
  const prompt = `Suggest 4 creative ideas for a social media ${kind}${context ? ` about: "${context}"` : ''}. Each idea in one short sentence. Put each on its own line.`;
  const raw = await brainGenerate({ prompt, sessionId });
  return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s.length > 5).slice(0, 4);
}
