/**
 * Identity of a focused element across two reads.
 *
 * Extracted from assertFocusMove so the sequence runner uses exactly the same
 * notion of "the same element". If these two ever disagreed, a run would report
 * moves the single-step tool did not, and the cycle detector below would either
 * invent loops or miss them.
 *
 * A verified selector is the strongest handle available. Without one, fall back
 * to tag + text + position -- deliberately NOT the element's own id, which on
 * Steam's React tree is regenerated per render and would make every read look
 * like a move.
 */
import type { FocusElement, ReadFocusResult } from "./readFocus.js";

export function focusKey(r: ReadFocusResult | null): string | null {
  const el = r?.gpfocus;
  if (!el) return null;
  if (el.selector && el.selectorVerified) return `sel:${el.selector}`;
  const rect = el.rect ? `${el.rect.x},${el.rect.y},${el.rect.w},${el.rect.h}` : "no-rect";
  return `id:${el.tag}|${el.text}|${rect}`;
}

/** Short human label for a focused element, for diagnoses and run logs. */
export function describe(r: ReadFocusResult | null): string {
  return describeElement(r?.gpfocus ?? null);
}

export function describeElement(el: FocusElement | null): string {
  if (!el) return "nothing";
  // ownerText last: it belongs to an ancestor, so it is the weakest of the three
  // and only worth using when the element itself is anonymous -- which every
  // Decky ToggleField's focus target is.
  const own = el.text || el.ariaLabel || "";
  if (own) return `<${el.tag}> "${own}"`;
  const owner = el.ownerText ?? "";
  return owner ? `<${el.tag}> in "${owner}"` : `<${el.tag}>`;
}
