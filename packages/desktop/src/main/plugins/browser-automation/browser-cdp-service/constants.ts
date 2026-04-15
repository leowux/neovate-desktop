export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "gridcell",
]);

export const DEVICE_PRESETS: Record<
  string,
  { width: number; height: number; scale: number; mobile: boolean; userAgent: string }
> = {
  "iPhone 14": {
    width: 390,
    height: 844,
    scale: 3,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  },
};

export const WAIT_FOR_LOAD_TIMEOUT = 15_000;
export const WAIT_FOR_VIEW_TIMEOUT = 8_000;
export const LOG_CAP = 1000;
export const ERROR_CAP = 300;
export const REQUEST_CAP = 500;
export const NETWORK_IDLE_QUIET_MS = 500;

export const LOCATOR_HELPERS_JS = `
  const __nvNormalize = (value) => String(value ?? "").trim().replace(/\\s+/g, " ");
  const __nvText = (el) => __nvNormalize(el.innerText || el.textContent || "");
  const __nvLabel = (el) => {
    if (!el) return "";
    const ariaLabel = el.getAttribute && el.getAttribute("aria-label");
    if (ariaLabel) return __nvNormalize(ariaLabel);
    const labels = el.labels ? Array.from(el.labels).map((label) => __nvText(label)).filter(Boolean) : [];
    if (labels.length > 0) return __nvNormalize(labels.join(" "));
    const parentLabel = el.closest && el.closest("label");
    if (parentLabel) return __nvText(parentLabel);
    return "";
  };
  const __nvName = (el) => {
    const ariaLabel = el.getAttribute && el.getAttribute("aria-label");
    const placeholder = el.getAttribute && el.getAttribute("placeholder");
    const alt = el.getAttribute && el.getAttribute("alt");
    const title = el.getAttribute && el.getAttribute("title");
    const label = __nvLabel(el);
    const value = "value" in el ? __nvNormalize(el.value) : "";
    return __nvNormalize(ariaLabel || label || placeholder || alt || title || value || __nvText(el));
  };
  const __nvRole = (el) => {
    const role = el.getAttribute && el.getAttribute("role");
    if (role) return role.toLowerCase();
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return tag;
  };
  const __nvMatch = (candidate, expected, exact) => {
    const left = __nvNormalize(candidate);
    const right = __nvNormalize(expected);
    if (!right) return true;
    if (exact) return left === right;
    return left.toLowerCase().includes(right.toLowerCase());
  };
`;
