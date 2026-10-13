import { describe, expect, it } from "vitest";
import {
  INITIAL_SIGN_IN_EPISODE,
  openSignInEpisode,
  resolveSignInEpisode,
  signInDedupeKey,
  signedOutDedupeKey,
} from "./agent-signin-rules";

describe("sign-in episodes", () => {
  it("keeps one dedupe key across repeated signals until resolved", () => {
    let s = INITIAL_SIGN_IN_EPISODE;
    const keys = new Set<string>();
    for (let i = 0; i < 5; i++) {
      s = openSignInEpisode(s);
      keys.add(signInDedupeKey("cursor", s.episode));
    }
    expect(keys.size).toBe(1);
  });

  it("re-arms after resolution: the next failure is a new key", () => {
    let s = openSignInEpisode(INITIAL_SIGN_IN_EPISODE);
    const first = signInDedupeKey("cursor", s.episode);
    s = resolveSignInEpisode(s);
    s = openSignInEpisode(s);
    expect(signInDedupeKey("cursor", s.episode)).not.toBe(first);
  });

  it("resolving with nothing open changes nothing", () => {
    expect(resolveSignInEpisode(INITIAL_SIGN_IN_EPISODE)).toBe(INITIAL_SIGN_IN_EPISODE);
  });

  it("keys differ per agent and from the DeskMate sign-out", () => {
    expect(signInDedupeKey("a", 0)).not.toBe(signInDedupeKey("b", 0));
    expect(signedOutDedupeKey(0)).not.toBe(signedOutDedupeKey(1));
  });
});
