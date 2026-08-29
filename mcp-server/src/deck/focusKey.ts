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

/**
 * The one name for a focused control, used by every matcher in the rig.
 *
 * readFocus computes this on the page (see FocusElement.label) the way an
 * accessibility tree does. Ranking the raw fields here instead is what caused
 * P1-10: three callers each ordered `text` / `ariaLabel` / `ownerText`
 * differently, walkTo put full-subtree text ahead of the element's own
 * aria-label, and an icon-only tab with no text of its own borrowed the entire
 * Quick Access Menu's text and substring-matched against it.
 *
 * The fallback covers a payload computed before that field existed -- the older
 * three-field shape, and every test fixture written against it. It puts
 * aria-label first, which is the ordering the old doc comments always claimed
 * and the code never did.
 */
export function labelOfElement(el: FocusElement | null): string {
  if (!el) return "";
  if (el.label !== undefined) return el.label.trim();
  return (el.ariaLabel || el.text || el.ownerText || "").trim();
}

/**
 * True when the label describes something the ring is INSIDE rather than the
 * focused element itself. Callers that must not act on a borrowed name -- an "is
 * this the plugin's list row" test, say -- check this before trusting the label.
 */
export function labelIsBorrowed(el: FocusElement | null): boolean {
  return typeof el?.labelSource === "string" && el.labelSource.startsWith("ancestor-");
}

/** Short human label for a focused element, for diagnoses and run logs. */
export function describe(r: ReadFocusResult | null): string {
  return describeElement(r?.gpfocus ?? null);
}

export function describeElement(el: FocusElement | null): string {
  if (!el) return "nothing";

  if (el.label !== undefined) {
    const label = el.label.trim();
    if (!label) {
      // Saying WHY it is nameless matters: "no label" and "the ring is on a
      // container whose text is a whole pane" send a reader to different places.
      return el.labelOverflow
        ? `<${el.tag}> (unnamed - the only text around it is a container's, not a label)`
        : `<${el.tag}>`;
    }
    // `in "X"` for a borrowed name, so a log never reads as though the ring were
    // on the thing that carries the text.
    return labelIsBorrowed(el) ? `<${el.tag}> in "${label}"` : `<${el.tag}> "${label}"`;
  }

  // Pre-`label` payload. ownerText last: it belongs to an ancestor, so it is the
  // weakest of the three and only worth using when the element itself is
  // anonymous -- which every Decky ToggleField's focus target is.
  const own = el.text || el.ariaLabel || "";
  if (own) return `<${el.tag}> "${own}"`;
  const owner = el.ownerText ?? "";
  return owner ? `<${el.tag}> in "${owner}"` : `<${el.tag}>`;
}
