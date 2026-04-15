import { describe, expect, it } from "vitest";

import {
  modifierFlag,
  parseKey,
} from "../../src/main/plugins/browser-automation/browser-cdp-service";

describe("keyboard-helpers: parseKey", () => {
  it("maps Return to Enter", () => {
    const result = parseKey("Return");
    expect(result.key).toBe("Enter");
    expect(result.code).toBe("Enter");
  });

  it("maps Esc to Escape", () => {
    const result = parseKey("Esc");
    expect(result.key).toBe("Escape");
    expect(result.code).toBe("Escape");
  });

  it("maps Space to ' ' (space character)", () => {
    const result = parseKey("Space");
    expect(result.key).toBe(" ");
    expect(result.code).toBe("Space");
  });

  it("maps arrow key names", () => {
    expect(parseKey("Left").key).toBe("ArrowLeft");
    expect(parseKey("Right").key).toBe("ArrowRight");
    expect(parseKey("Up").key).toBe("ArrowUp");
    expect(parseKey("Down").key).toBe("ArrowDown");
  });

  it("computes code for single-letter keys", () => {
    expect(parseKey("a")).toEqual({ key: "a", code: "KeyA", modifiers: 0 });
    expect(parseKey("Z")).toEqual({ key: "Z", code: "KeyZ", modifiers: 0 });
  });

  it("passes through unknown keys unchanged", () => {
    expect(parseKey("Tab")).toEqual({ key: "Tab", code: "Tab", modifiers: 0 });
    expect(parseKey("Enter")).toEqual({ key: "Enter", code: "Enter", modifiers: 0 });
  });

  it("trims whitespace", () => {
    expect(parseKey("  a  ")).toEqual({ key: "a", code: "KeyA", modifiers: 0 });
  });
});

describe("keyboard-helpers: modifierFlag", () => {
  it("returns correct flags for each modifier", () => {
    expect(modifierFlag("alt")).toBe(1);
    expect(modifierFlag("control")).toBe(2);
    expect(modifierFlag("ctrl")).toBe(2);
    expect(modifierFlag("meta")).toBe(4);
    expect(modifierFlag("command")).toBe(4);
    expect(modifierFlag("cmd")).toBe(4);
    expect(modifierFlag("shift")).toBe(8);
  });

  it("returns 0 for unknown modifiers", () => {
    expect(modifierFlag("hyper")).toBe(0);
    expect(modifierFlag("")).toBe(0);
  });
});
