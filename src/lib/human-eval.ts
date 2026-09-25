// Human-eval producer for Equyvo.
//
// IMPORTANT: Equyvo does NOT contain / host Acronous LLM. There is no vendored
// model, no Ollama call, no training loop in this app. The ONLY shared-brain
// touchpoints are:
//   1. Search + feed ranking (GET /api/search, /api/feed, /api/suggest/*,
//      /api/trending/topics) — the algorithm that decides what content to show.
//   2. Human-eval signals (POST /api/engagement, /api/learn, /api/feedback) —
//      every user input below becomes a labelled preference for the shared
//      brain hosted elsewhere (Acronous AI / Contabo side).
//
// All sends are fire-and-forget and never block UI. Failures are swallowed.

import { brainFeedback, brainLearn } from './brain';

export type EvalAction =
  | 'like'
  | 'unlike'
  | 'upvote'
  | 'downvote'
  | 'save'
  | 'unsave'
  | 'share'
  | 'comment'
  | 'view'
  | 'follow'
  | 'unfollow'
  | 'report'
  | 'search';

const RATING_BY_ACTION: Record<EvalAction, number> = {
  like: 0.5,
  unlike: -0.2,
  upvote: 1,
  downvote: -1,
  save: 0.9,
  unsave: -0.2,
  share: 0.8,
  comment: 0.6,
  view: 0.1,
  follow: 0.4,
  unfollow: -0.3,
  report: -1,
  search: 0.4,
};

function currentUserId(): string {
  try {
    const stored = localStorage.getItem('equyvo_cognito_user');
    if (stored) {
      const u = JSON.parse(stored);
      const id = u?.id || u?.email || '';
      if (id) return String(id);
    }
  } catch {
    /* ignore */
  }
  return 'anonymous';
}

async function postEngagement(payload: Record<string, unknown>): Promise<void> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    try {
      const token = localStorage.getItem('equyvo_cognito_token');
      if (token) headers['Authorization'] = 'Bearer ' + token;
    } catch {
      /* ignore */
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      await fetch('/api/engagement', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      }).catch(() => null);
    } finally {
      clearTimeout(t);
    }
  } catch {
    /* never throw into UI */
  }
}

export interface HumanEvalInput {
  itemId: string;
  action: EvalAction;
  /** Optional content snapshot / query text (capped server-side). */
  text?: string;
  category?: string;
  tags?: string[];
  creator?: string;
  /** Override the default rating for this action. */
  rating?: number;
}

/** Send one human-eval signal. Fire-and-forget — callers must NOT await. */
export function sendHumanEval(input: HumanEvalInput): void {
  const itemId = String(input.itemId || '').slice(0, 128);
  if (!itemId) return;
  const action = input.action;
  const rating =
    typeof input.rating === 'number' && Number.isFinite(input.rating)
      ? Math.max(-1, Math.min(1, input.rating))
      : RATING_BY_ACTION[action] ?? 0;
  const uid = currentUserId();
  const text = String(input.text || itemId).slice(0, 300);

  // 1. Local interest/popularity signal (ranking algorithm input).
  void postEngagement({
    userId: uid,
    user_id: uid,
    action,
    itemId,
    item_id: itemId,
    category: input.category || '',
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 10) : [],
    creator: input.creator || '',
  });

  // 2. Shared-brain preference label (explicit rating).
  void brainFeedback({
    sessionId: uid,
    query: text,
    rating,
    response: `${action}:${itemId}`,
    source: 'equyvo',
  }).catch(() => null);

  // 3. Shared-brain weak label (retrieval / suggest training).
  void brainLearn({
    query: text,
    response: `user ${action} ${itemId}`,
    feedback: rating,
    sessionId: uid,
    source: 'equyvo',
    routeType: 'equyvo-feed',
  }).catch(() => null);
}

/** Convenience: vote buttons (thoughts). */
export function evalVote(itemId: string, voteType: 'upvote' | 'downvote', text?: string): void {
  sendHumanEval({ itemId, action: voteType, text });
}

/** Convenience: like buttons (posts / moments / thoughts). */
export function evalLike(itemId: string, liked: boolean, text?: string): void {
  sendHumanEval({ itemId, action: liked ? 'like' : 'unlike', text });
}

/** Convenience: safety reports become strong negative labels. */
export function evalReport(itemId: string, reason: string): void {
  sendHumanEval({
    itemId,
    action: 'report',
    rating: -1,
    text: `${itemId} reported:${String(reason || 'other').slice(0, 40)}`,
  });
}
