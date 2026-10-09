// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ModelPicker, searchScore } from "./model-picker";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import type { SessionModeInfo } from "@/types/agents";
import { isMac } from "@/lib/platform";
import { displayLabel, parseCombo } from "@/features/keybindings/lib/combo";

// The settings store subscribes to `config.toml` changes over Tauri events at
// import; there is no Tauri here.
vi.mock("@/features/settings/lib/atlas-config-api", () => ({
  updateSettings: vi.fn(),
  resetConfig: vi.fn(),
  onConfigChanged: () => Promise.resolve(() => {}),
  onConfigError: () => Promise.resolve(() => {}),
}));

const MODELS: SessionModeInfo[] = [
  { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
  { id: "gpt-5", name: "GPT-5", provider: "openai", description: "Strong at refactors" },
  { id: "house", name: "House model" },
];

/** Settings writes go to `config.toml` through Rust; here they land in the
 *  store directly, which is all the picker reads. */
function stubSettingsWrites(favoriteModels: string[] = []) {
  useSettingsStore.setState((s) => ({
    settings: { ...s.settings, favoriteModels },
    actions: {
      ...s.actions,
      updateSettings: (patch) =>
        useSettingsStore.setState((st) => ({ settings: { ...st.settings, ...patch } })),
    },
  }));
}

function picker(onPick: (id: string) => void, currentModel: string, models: SessionModeInfo[]) {
  return (
    <ModelPicker agentType="codex" models={models} currentModel={currentModel} onPick={onPick} />
  );
}

function renderPicker(onPick = vi.fn(), currentModel = "claude-sonnet-4", models = MODELS) {
  const r = render(picker(onPick, currentModel, models));
  return {
    onPick,
    rerender: (m: SessionModeInfo[], cur = currentModel) => r.rerender(picker(onPick, cur, m)),
  };
}

const input = () => screen.getByRole("combobox");
const rows = () =>
  screen.queryAllByRole("option").map((o) => o.querySelector(".label")?.textContent);
/** The row the combobox points at — what Enter would pick. */
const highlighted = () => {
  const id = input().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.querySelector(".label")?.textContent : null;
};
const railButtons = () =>
  within(screen.getByRole("toolbar", { name: "Providers" })).getAllByRole("button");
const pressed = () =>
  railButtons()
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.getAttribute("aria-label"));
const key = (k: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(document.activeElement ?? input(), { key: k, code: k, ...init });
/** A `cmd+…` chord as this platform types it. */
const chord = (k: string, code: string, shift = false) =>
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: k,
    code,
    shiftKey: shift,
    metaKey: isMac,
    ctrlKey: !isMac,
  });
const jump = (n: number) => chord(String(n), `Digit${n}`);
const type = (value: string) => fireEvent.change(input(), { target: { value } });

describe("ModelPicker", () => {
  beforeEach(() => stubSettingsWrites());
  afterEach(cleanup);

  it("builds the rail from the providers the agent stated, and files the rest under the agent", () => {
    renderPicker();
    expect(railButtons().map((t) => t.getAttribute("aria-label"))).toEqual([
      "Favorites",
      "Claude",
      "OpenAI",
      "Codex",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(rows()).toEqual(["House model"]);
  });

  it("keeps stated provider names separate from the Favorites and agent views", () => {
    renderPicker(vi.fn(), "custom", [
      { id: "custom", name: "Custom", provider: "favorites" },
      { id: "other", name: "Other", provider: "agent" },
      { id: "house", name: "House" },
    ]);
    expect(rows()).toEqual(["Custom"]);
    fireEvent.click(railButtons()[0]!);
    expect(rows()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(rows()).toEqual(["Other"]);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(rows()).toEqual(["House"]);
  });

  describe("accessibility", () => {
    it("is a list-autocomplete combobox pointing at the highlighted option", () => {
      renderPicker();
      expect(input().getAttribute("aria-autocomplete")).toBe("list");
      expect(input().getAttribute("aria-expanded")).toBe("true");
      const listbox = screen.getByRole("listbox");
      expect(input().getAttribute("aria-controls")).toBe(listbox.id);
      expect(highlighted()).toBe("Claude Sonnet 4");
    });

    it("nests nothing interactive inside an option", () => {
      renderPicker();
      for (const option of screen.getAllByRole("option")) {
        expect(option.querySelector("button, a, input, [tabindex]")).toBeNull();
      }
      // The star is still a real button, beside its option.
      expect(screen.getAllByRole("button", { name: "Add to favorites" }).length).toBeGreaterThan(0);
    });

    it("renders the rail as pressed toggle buttons, not tabs without panels", () => {
      renderPicker();
      expect(screen.queryByRole("tab")).toBeNull();
      expect(screen.queryByRole("tablist")).toBeNull();
      expect(pressed()).toEqual(["Claude"]);
    });

    it("collapses aria-expanded and drops the active descendant when nothing matches", () => {
      renderPicker();
      type("zzz");
      expect(input().getAttribute("aria-expanded")).toBe("false");
      expect(input().getAttribute("aria-activedescendant")).toBeNull();
    });
  });

  describe("keyboard", () => {
    it("moves with the arrows and wraps at both ends", () => {
      renderPicker();
      expect(rows()).toEqual(["Claude Opus 5", "Claude Sonnet 4"]);
      expect(highlighted()).toBe("Claude Sonnet 4");
      key("ArrowDown");
      expect(highlighted()).toBe("Claude Opus 5");
      key("ArrowUp");
      expect(highlighted()).toBe("Claude Sonnet 4");
    });

    it("picks the highlighted model on Enter", () => {
      const { onPick } = renderPicker();
      key("ArrowUp");
      key("Enter");
      expect(onPick).toHaveBeenCalledWith("claude-opus-5");
    });

    it("ignores Enter and the arrows while an IME is composing", () => {
      const { onPick } = renderPicker();
      key("ArrowDown", { isComposing: true });
      expect(highlighted()).toBe("Claude Sonnet 4");
      key("Enter", { isComposing: true });
      key("Enter", { keyCode: 229 });
      expect(onPick).not.toHaveBeenCalled();
    });

    it("steps through the rail with ⌘⇧↑ / ⌘⇧↓, wrapping", () => {
      renderPicker();
      expect(pressed()).toEqual(["Claude"]);
      chord("ArrowDown", "ArrowDown", true);
      expect(pressed()).toEqual(["OpenAI"]);
      expect(rows()).toEqual(["GPT-5"]);
      expect(highlighted()).toBe("GPT-5");
      chord("ArrowDown", "ArrowDown", true);
      chord("ArrowDown", "ArrowDown", true);
      expect(pressed()).toEqual(["Favorites"]);
      chord("ArrowUp", "ArrowUp", true);
      expect(pressed()).toEqual(["Codex"]);
    });

    it("moves to the rail with ← on an empty query or ⇧⇥, along it with ↑/↓, and back with →", () => {
      renderPicker();
      key("ArrowLeft");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Claude");
      // One tab stop: only the shown provider is in the tab order.
      expect(railButtons().filter((b) => b.tabIndex === 0)).toHaveLength(1);
      key("ArrowDown");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("OpenAI");
      key("ArrowUp");
      key("ArrowUp");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Favorites");
      key("ArrowRight");
      expect(document.activeElement).toBe(input());
      key("Tab", { shiftKey: true });
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Claude");
    });

    it("keeps ← for the caret once there is a query", () => {
      renderPicker();
      type("cl");
      key("ArrowLeft");
      expect(document.activeElement).toBe(input());
    });

    it("stars the highlighted row with its registered chord", () => {
      renderPicker();
      chord("s", "KeyS", true);
      expect(useSettingsStore.getState().settings.favoriteModels).toEqual([
        "codex:claude-sonnet-4",
      ]);
      // And again unstars it.
      chord("s", "KeyS", true);
      expect(useSettingsStore.getState().settings.favoriteModels).toEqual([]);
    });

    it("leaves registered shortcuts alone while the IME is composing", () => {
      const { onPick } = renderPicker();
      const composingChord = { ctrlKey: !isMac, metaKey: isMac, isComposing: true };
      key("1", { ...composingChord, code: "Digit1" });
      key("s", { ...composingChord, shiftKey: true, code: "KeyS" });
      expect(onPick).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().settings.favoriteModels).toEqual([]);
    });

    it("matches all search words and ranks favorites first only for equal matches", () => {
      stubSettingsWrites(["codex:house"]);
      const { onPick } = renderPicker(vi.fn(), "gpt-5", [
        { id: "other", name: "Rocket", description: "Fast helper" },
        { id: "house", name: "Rocket", description: "Fast helper" },
        { id: "slow", name: "Rocket", description: "Careful helper" },
      ]);
      type("rocket fast");
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toHaveLength(2);
      key("Enter");
      expect(onPick).toHaveBeenCalledWith("house");
    });

    it("shows each model row's jump chord", () => {
      renderPicker();
      const label = (n: number) => displayLabel(parseCombo(`cmd+${n}`)!);
      const kbds = screen.getAllByRole("option").map((o) => o.querySelector("kbd")?.textContent);
      expect(kbds).toEqual([label(1), label(2)]);
    });

    it("picks the Nth visible model and ignores unavailable row numbers", () => {
      const { onPick } = renderPicker(vi.fn(), "claude-sonnet-4", [
        ...MODELS,
        { id: "claude-extra", name: "Claude Extra", provider: "anthropic" },
      ]);
      jump(2);
      expect(onPick).toHaveBeenLastCalledWith("claude-sonnet-4");
      jump(3);
      expect(onPick).toHaveBeenLastCalledWith("claude-extra");
      jump(9);
      expect(onPick).toHaveBeenCalledTimes(2);
    });

    it("answers its chords only while focus is inside it", () => {
      const first = vi.fn();
      const second = vi.fn();
      render(
        <>
          {picker(first, "claude-sonnet-4", MODELS)}
          {picker(second, "claude-sonnet-4", MODELS)}
        </>,
      );
      const [a] = screen.getAllByRole("combobox");
      act(() => a!.focus());
      jump(1);
      expect(first).toHaveBeenCalledWith("claude-opus-5");
      expect(second).not.toHaveBeenCalled();
      act(() => (document.activeElement as HTMLElement).blur());
      jump(1);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
    });

    it("does not let an unavailable model number trigger a global tab shortcut", () => {
      const globalShortcut = vi.fn();
      window.addEventListener("keydown", globalShortcut);
      try {
        renderPicker();
        jump(9);
        expect(globalShortcut).not.toHaveBeenCalled();
        act(() => (document.activeElement as HTMLElement).blur());
        jump(9);
        expect(globalShortcut).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener("keydown", globalShortcut);
      }
    });
  });

  describe("highlight", () => {
    it("highlights the best match when searching, not the current model", () => {
      renderPicker();
      type("claude");
      expect(highlighted()).toBe("Claude Opus 5");
      type("");
      expect(highlighted()).toBe("Claude Sonnet 4");
    });

    it("stays on the same model when starring reorders the list", () => {
      renderPicker();
      key("ArrowDown"); // Wrap to the first row
      key("ArrowUp"); // Claude Sonnet 4
      expect(highlighted()).toBe("Claude Sonnet 4");
      chord("s", "KeyS", true);
      expect(rows()[0]).toBe("Claude Sonnet 4");
      expect(highlighted()).toBe("Claude Sonnet 4");
    });

    it("follows its model through a refreshed list, and clamps when it leaves", () => {
      const { rerender } = renderPicker();
      key("ArrowUp"); // Claude Opus 5
      // A refresh that puts a new model first: the highlight stays on Opus.
      const refreshed = [{ id: "claude-x", name: "Claude X", provider: "anthropic" }, ...MODELS];
      rerender(refreshed);
      expect(highlighted()).toBe("Claude Opus 5");
      // Opus is withdrawn: the highlight holds its slot.
      rerender(refreshed.filter((m) => m.id !== "claude-opus-5"));
      expect(rows()).toEqual(["Claude X", "Claude Sonnet 4"]);
      expect(highlighted()).toBe("Claude Sonnet 4");
    });

    it("scrolls for the keyboard but not under the mouse", () => {
      const scroll = vi.fn();
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scroll;
      onTestFinished(() => {
        Element.prototype.scrollIntoView = original;
      });
      renderPicker();
      scroll.mockClear();
      fireEvent.mouseMove(screen.getAllByRole("option")[0]!.parentElement!);
      expect(highlighted()).toBe("Claude Opus 5");
      expect(scroll).not.toHaveBeenCalled();
      key("ArrowDown");
      expect(scroll).toHaveBeenCalled();
    });
  });

  describe("models arriving after open", () => {
    it("chooses the view from the first non-empty list", () => {
      const { rerender } = renderPicker(vi.fn(), "gpt-5", []);
      expect(screen.getByText("No models")).toBeTruthy();
      expect(screen.queryByRole("toolbar")).toBeNull();
      rerender(MODELS);
      expect(pressed()).toEqual(["OpenAI"]);
      expect(highlighted()).toBe("GPT-5");
      // Chosen ONCE: a later refresh keeps what the user is looking at.
      fireEvent.click(screen.getByRole("button", { name: "Claude" }));
      rerender([...MODELS]);
      expect(pressed()).toEqual(["Claude"]);
    });

    it("opens on Favorites when the late list has a starred model", () => {
      stubSettingsWrites(["codex:gpt-5"]);
      const { rerender } = renderPicker(vi.fn(), "claude-sonnet-4", []);
      rerender(MODELS);
      expect(pressed()).toEqual(["Favorites"]);
      expect(rows()).toEqual(["GPT-5"]);
    });
  });

  describe("search", () => {
    it("searches across every provider and hides the rail while it does", () => {
      renderPicker();
      type("gpt");
      expect(rows()).toEqual(["GPT-5"]);
      expect(screen.queryByRole("toolbar")).toBeNull();
      type("openai");
      expect(rows()).toEqual(["GPT-5"]);
    });

    it("matches the description, below name and id matches", () => {
      renderPicker();
      type("refactors");
      expect(rows()).toEqual(["GPT-5"]);
    });

    it("never ranks a provider-label match above a name match", () => {
      const models: SessionModeInfo[] = [
        { id: "m1", name: "Tuned", provider: "anthropic" },
        { id: "m2", name: "Claude Opus 5", provider: "openai" },
      ];
      renderPicker(vi.fn(), "m1", models);
      type("claude");
      expect(rows()).toEqual(["Claude Opus 5", "Tuned"]);
    });

    it("says so when nothing matches", () => {
      renderPicker();
      type("zzz");
      expect(screen.getByText("No models match “zzz”")).toBeTruthy();
    });
  });

  it("scores name above id above description above provider", () => {
    const m: SessionModeInfo = {
      id: "acme-fast",
      name: "Rocket",
      description: "quick helper",
      provider: "Claude",
    };
    const score = (q: string) => searchScore(m, "Claude", q);
    expect(score("rocket")).toBeLessThan(score("acme")!);
    expect(score("acme")).toBeLessThan(score("quick")!);
    expect(score("quick")).toBeLessThan(score("claude")!);
    expect(score("nope")).toBeNull();
  });

  it("says so when the agent advertised no models", () => {
    renderPicker(vi.fn(), "x", []);
    expect(screen.getByText("No models")).toBeTruthy();
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
  });

  it("stars into settings, and a starred model opens the picker on Favorites", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "OpenAI" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
    expect(useSettingsStore.getState().settings.favoriteModels).toEqual(["codex:gpt-5"]);
    cleanup();
    renderPicker();
    expect(pressed()).toEqual(["Favorites"]);
    expect(rows()).toEqual(["GPT-5"]);
  });

  it("says so when the favorites view is empty", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
    expect(screen.getByText("No favorites yet")).toBeTruthy();
  });
});
