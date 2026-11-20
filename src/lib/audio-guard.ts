/**
 * Audio rights guard — Equyvo "Use this audio".
 *
 * A Moment's own soundtrack is its creator's ORIGINAL AUDIO and must never be
 * reused to compose someone else's Moment/Photo (copyright + platform
 * originality). Only tracks that are explicitly licensed music from Equyvo's
 * own audio library, or audio the current user uploaded themselves, may be
 * used. The check is layered:
 *
 *   1. Deterministic ownership/source rules (hard block, cannot be overridden)
 *   2. AI classification of the track metadata via the shared brain
 *   3. Fail-closed default: unknown == original audio == not reusable
 */
import { brainGenerate } from './brain';
import type { ExternalAudioTrack } from './external-audio';

export type AudioKind = 'music' | 'original';

export interface AudioGuardResult {
  kind: AudioKind;
  reusable: boolean;
  confidence: number;
  reason: string;
  source: 'rule' | 'ai' | 'fail-closed';
}

const BLOCKED: Omit<AudioGuardResult, 'reason'> = {
  kind: 'original',
  reusable: false,
  confidence: 1,
  source: 'rule',
};

function lower(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

/** Cheap synchronous check used at every entry point (UI + publish). */
export function isReusableAudio(track: ExternalAudioTrack | null | undefined): boolean {
  if (!track) return false;
  if (track.kind === 'original' || track.reusable === false) return false;
  if (track.verified === false) return false;
  if (track.source === 'moment') return false; // a Moment video's own audio
  if (track.source === 'library' || track.source === 'upload') return true;
  // Legacy tracks without a source are only trusted when explicitly marked.
  return track.kind === 'music' && track.reusable === true;
}

/** Deterministic rules that always win over the AI verdict. */
export function ownershipVerdict(
  track: ExternalAudioTrack,
  currentUserId: string,
): AudioGuardResult | null {
  const me = lower(currentUserId);
  const owner = lower(track.sourceOwnerId);

  // Someone else's upload/original audio can never be reused.
  if (owner && me && owner !== me) {
    return { ...BLOCKED, reason: 'This is another creator’s original audio and cannot be reused.' };
  }
  // Audio taken straight from a Moment video is original audio by definition,
  // unless it is the current user's own library/upload track.
  if (track.source === 'moment' && !(me && owner === me)) {
    return { ...BLOCKED, reason: 'This is the creator’s original audio, not licensed music.' };
  }
  if (track.kind === 'original') {
    return { ...BLOCKED, reason: 'Original audio from a Moment cannot be used for composition.' };
  }
  return null;
}

function parseAiVerdict(raw: string): { kind: AudioKind; reason: string } | null {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  try {
    const obj = JSON.parse(match ? match[0] : raw);
    const kind = lower(obj.kind || obj.verdict || obj.classification);
    if (kind === 'music' || kind.includes('music')) {
      return { kind: 'music', reason: String(obj.reason || 'Classified as licensed music.') };
    }
    if (kind === 'original' || kind.includes('original') || kind.includes('speech')) {
      return { kind: 'original', reason: String(obj.reason || 'Classified as original audio.') };
    }
  } catch { /* fall through to keyword matching */ }
  const text = lower(raw);
  if (/\b(music|song|track|melody|instrumental|beat)\b/.test(text) && !/\boriginal audio\b/.test(text)) {
    return { kind: 'music', reason: 'AI identified this as music.' };
  }
  if (/\b(original|speech|voice|dialogue|podcast)\b/.test(text)) {
    return { kind: 'original', reason: 'AI identified this as original audio/voice.' };
  }
  return null;
}

/**
 * Full classification. Always resolves — never throws — and fails closed
 * (original / not reusable) when the AI is unreachable or ambiguous.
 */
export async function classifyAudio(
  track: ExternalAudioTrack,
  currentUserId: string,
): Promise<AudioGuardResult> {
  const hard = ownershipVerdict(track, currentUserId);
  if (hard) return hard;

  // Audio the user just uploaded is theirs; no remote classification needed.
  if (track.source === 'upload' && track.kind === 'music' && track.reusable) {
    return {
      kind: 'music', reusable: true, confidence: 0.99,
      reason: 'Audio you uploaded — you can use it in your own posts.', source: 'rule',
    };
  }

  const prompt = [
    'You are an audio rights classifier for a short-video app.',
    'Decide whether the audio described below is licensed MUSIC that may be reused,',
    'or ORIGINAL AUDIO recorded by a creator that must never be reused.',
    'Return ONLY compact JSON: {"kind":"music"|"original","reason":"short reason"}.',
    '',
    `Title: ${track.name}`,
    `Attached creator: ${track.creator}`,
    `Source: ${track.source || 'unknown'}`,
    `Track marked reusable by source: ${track.reusable === true ? 'yes' : 'no'}`,
    `Media URL: ${track.url}`,
  ].join('\n');

  try {
    const raw = await brainGenerate({
      prompt,
      system: 'You classify audio solely for copyright safety. When unsure, answer "original".',
    });
    const verdict = parseAiVerdict(raw);
    if (verdict?.kind === 'music' && isReusableAudio(track)) {
      return {
        kind: 'music', reusable: true, confidence: 0.9,
        reason: verdict.reason, source: 'ai',
      };
    }
    if (verdict?.kind === 'original') {
      return {
        kind: 'original', reusable: false, confidence: 0.9,
        reason: verdict.reason, source: 'ai',
      };
    }
  } catch { /* AI is best-effort — fail closed below */ }

  return {
    kind: 'original', reusable: false, confidence: 0.6,
    reason: 'Audio could not be verified as licensed music.', source: 'fail-closed',
  };
}
