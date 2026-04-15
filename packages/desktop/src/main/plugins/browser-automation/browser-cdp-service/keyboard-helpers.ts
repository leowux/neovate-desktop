export function parseKey(key: string): { key: string; code: string; modifiers: number } {
  const normalized = key.trim();
  const keyMap: Record<string, string> = {
    Return: "Enter",
    Esc: "Escape",
    Space: " ",
    Left: "ArrowLeft",
    Right: "ArrowRight",
    Up: "ArrowUp",
    Down: "ArrowDown",
  };
  const mapped = keyMap[normalized] ?? normalized;
  const code =
    mapped.length === 1 && /[a-z]/i.test(mapped)
      ? `Key${mapped.toUpperCase()}`
      : mapped === " "
        ? "Space"
        : mapped;
  return { key: mapped, code, modifiers: 0 };
}

export function modifierFlag(name: string): number {
  switch (name) {
    case "alt":
      return 1;
    case "control":
    case "ctrl":
      return 2;
    case "meta":
    case "command":
    case "cmd":
      return 4;
    case "shift":
      return 8;
    default:
      return 0;
  }
}
