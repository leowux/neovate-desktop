/**
 * JavaScript injected into the webview to index all interactive DOM elements.
 * Returns a JSON string with { url, title, elements[] }.
 * Each element gets a data-nv-index attribute for click/input targeting.
 */
export const INJECT_ELEMENT_INDEXER = `(function () {
  var INTERACTIVE_SELECTORS = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="option"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ];

  var MAX_ELEMENTS = 500;

  function isVisible(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (rect.bottom < 0 || rect.top > window.innerHeight * 3) return false;
    return true;
  }

  function getElementLabel(el) {
    var label =
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      el.value ||
      el.textContent;
    if (!label) return '';
    return label.trim().replace(/\\s+/g, ' ').slice(0, 100);
  }

  function getElementType(el) {
    var tag = el.tagName.toLowerCase();
    var type = el.getAttribute('type');
    var role = el.getAttribute('role');
    if (role) return role;
    if (tag === 'input') return type || 'text';
    return tag;
  }

  // Remove old indices
  document.querySelectorAll('[data-nv-index]').forEach(function (el) {
    el.removeAttribute('data-nv-index');
  });

  var seen = new Set();
  var elements = [];
  var index = 1;

  var candidates = new Set();
  INTERACTIVE_SELECTORS.forEach(function (sel) {
    try {
      document.querySelectorAll(sel).forEach(function (el) { candidates.add(el); });
    } catch (e) {}
  });

  // Sort by document order
  var sorted = Array.from(candidates).sort(function (a, b) {
    var pos = a.compareDocumentPosition(b);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  for (var i = 0; i < sorted.length && elements.length < MAX_ELEMENTS; i++) {
    var el = sorted[i];
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isVisible(el)) continue;
    if (el.disabled) continue;

    var label = getElementLabel(el);
    var type = getElementType(el);
    el.setAttribute('data-nv-index', String(index));

    elements.push({
      index: index,
      tag: el.tagName.toLowerCase(),
      type: type,
      label: label,
      href: el.getAttribute('href') || undefined,
      isInput: ['input', 'textarea', 'select', 'textbox', 'searchbox', 'combobox'].includes(type),
    });

    index++;
  }

  return JSON.stringify({
    url: window.location.href,
    title: document.title,
    elements: elements,
  });
})()`;

export interface IndexedElement {
  index: number;
  tag: string;
  type: string;
  label: string;
  href?: string;
  isInput: boolean;
}

export interface BrowserState {
  url: string;
  title: string;
  elements: IndexedElement[];
}

export function formatBrowserState(state: BrowserState): string {
  const lines: string[] = [
    `URL: ${state.url}`,
    `Title: ${state.title}`,
    ``,
    `Interactive elements:`,
  ];
  for (const el of state.elements) {
    const label = state.url && el.href ? `${el.label} → ${el.href}` : el.label;
    lines.push(`[${el.index}] <${el.type}> ${label ? `"${label}"` : "(no label)"}`);
  }
  if (state.elements.length === 0) {
    lines.push("(no interactive elements found)");
  }
  return lines.join("\n");
}
