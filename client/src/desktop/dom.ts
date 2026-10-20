/**
 * A tiny element builder for the desktop page. Everything shown here that comes from
 * Discord (server, channel and user names) is user-controlled text, so it only ever
 * reaches the DOM as text nodes -- never through innerHTML.
 */

type Child = Node | string | null | undefined | false;
type Props = Record<string, string | boolean | ((event: Event) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") {
      element.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (value === true) {
      element.setAttribute(name, "");
    } else {
      element.setAttribute(name, value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

/** A trusted, hardcoded SVG icon (never user data) wrapped in a span. */
export function icon(svg: string, className = "desk-icon"): HTMLSpanElement {
  const span = h("span", { class: className, "aria-hidden": "true" });
  span.innerHTML = svg;
  return span;
}

/** Discord's default-avatar palette, minus red (reserved for the live badge). */
const AVATAR_COLORS = ["#5865f2", "#3ba55c", "#faa61a", "#eb459f", "#747f8d"];

function colorFor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** A round avatar: the Discord picture when there is one, colored initials otherwise. */
export function avatar(name: string, url: string | null, seed: string, className = "desk-avatar"): HTMLElement {
  if (url) return h("img", { class: className, src: url, alt: "" });
  const fallback = h("span", { class: `${className} is-initials`, "aria-hidden": "true" }, initials(name).slice(0, 1));
  fallback.style.background = colorFor(seed);
  return fallback;
}
