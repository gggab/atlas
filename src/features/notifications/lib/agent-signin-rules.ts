/**
 * Sign-in episodes — pure state in / state out. An agent that needs sign-in
 * tends to say so again and again (every retried turn, every thread bound to
 * it); one notification covers the lot until the user has signed in.
 *
 * An episode is open from the first auth-required signal until the agent is
 * known to work again (the sign-in dialog finished, or one of its turns
 * completed). The episode number is part of the dedupe key, so delivery
 * announces each episode once, and the next time the agent signs out is a new
 * episode and speaks again. Same shape for Atlas's own session.
 */

export interface SignInEpisode {
  /** Episodes closed so far; part of the dedupe key. */
  episode: number;
  /** A notification for the current episode has been raised. */
  open: boolean;
}

export const INITIAL_SIGN_IN_EPISODE: SignInEpisode = { episode: 0, open: false };

/** An auth-required signal arrived: the current episode is (still) open. */
export function openSignInEpisode(s: SignInEpisode): SignInEpisode {
  return s.open ? s : { ...s, open: true };
}

/** The user signed in (or the thing works again): close the episode so the
 *  next failure is a new one. A no-op when none is open. */
export function resolveSignInEpisode(s: SignInEpisode): SignInEpisode {
  return s.open ? { episode: s.episode + 1, open: false } : s;
}

/** An agent's sign-in notification (and its toast) key. */
export const signInDedupeKey = (agentType: string, episode: number) =>
  `agent-sign-in:${agentType}:${episode}`;

/** DeskMate's own signed-out notification key. */
export const signedOutDedupeKey = (episode: number) => `atlas-signed-out:${episode}`;
