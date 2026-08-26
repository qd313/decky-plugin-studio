# 03 — Opening a Decky plugin leaves gamepad focus unowned

Measured 2026-08-26 with `deck_readFocus` and the ESP32 bridge, on a live Deck, with nobody
touching the device. This is the first bug the rig found on its own.

**It is a platform behaviour, not a plugin bug.** That conclusion is the useful part, and it
was one control experiment away from being the opposite.

---

## 1. What happens

Open the Quick Access Menu, move to a plugin in the Decky list, press A. The plugin mounts and
renders. **Nothing owns gamepad focus.**

Measured inside bonsAI immediately after opening it:

| Signal | Value |
|---|---|
| Elements in the QAM target | 352 |
| Plugin's own elements rendered | 86 |
| `.Focusable` elements present | 67 |
| Elements carrying **any** `gpfocus*` class | **0** |
| `document.activeElement` | `<BODY>` |

So the UI is fully rendered and 67 controls are focusable, and Steam's nav graph owns none of
them. The focus ring is simply absent.

**It recovers on the next D-pad press.** The first press does not move focus — it re-acquires
it. So this is not a permanent freeze; it is one swallowed press every time a plugin opens,
plus a moment where the ring is nowhere.

The same thing happens on **exit**: pressing B to leave a plugin also lands in the unowned
state until the next press.

---

## 2. Why it is not bonsAI's bug

Three signals pointed at bonsAI: it was the plugin under test, it has known focus debt (51
page-search violations found by the Track B linter), and the symptom is exactly the
"focus may land nowhere → D-pad freezes" shape that linter rule R11 warns about.

All three were circumstantial. **The control experiment decided it:**

| Plugin | Focus after opening it |
|---|---|
| bonsAI | unowned |
| TabMaster | unowned |

TabMaster is an unrelated third-party plugin. It behaves identically, and the state persisted
3 s later, so it is not a slow mount either.

This is the same error class recorded in
[bonsAI plan 22](https://github.com/cantcurecancer/DeckySettingsSearch) — three convergent
signals pointing at one wrong conclusion. Without the control, the next step would have been
"fix bonsAI", patching a plugin for something Decky Loader does to every plugin.

---

## 3. Why the reading is trustworthy

The oracle reports "no focus owner" rather than a null focus, so this is a positive finding
rather than a silence. Two ways it could still have been wrong, both checked:

- **Another CEF target owned it.** All five were scanned — `QuickAccess_uid2`,
  `notificationtoasts_uid2`, `MainMenu_uid2`, `Steam Big Picture Mode`, `SharedJSContext`.
  None carried the marker.
- **A different DOM realm hid it.** Decky plugins could plausibly render into an iframe or a
  shadow root, which a top-level `querySelector` would not see into. Measured: **0 iframes**,
  **0 shadow roots carrying `gpfocus`**. The marker is genuinely absent, not hidden.

---

## 4. What a plugin author should do about it

Nothing here is fixable from inside a plugin — but it is compensable. If you want the ring to
land somewhere specific when your plugin opens, **take focus explicitly on mount** rather than
assuming Decky or Steam will place it. Otherwise your user's first D-pad press after opening
your plugin is spent re-acquiring focus rather than navigating.

This is now noted in `pack/docs/focus-graph-patterns.md`.

---

## 5. Status

**Reported, not fixed.** The fix, if there is one, belongs in Decky Loader rather than here or
in any plugin. Worth raising upstream with this measurement attached — it is a small, concrete,
reproducible report, which is the kind most likely to get acted on.

**Not usable for bonsAI milestone M4** ("a D-pad bug is reproduced by script, fixed, and locked
by a check that fails without the fix"). The reproduce half is done and was cheap. The fix half
is not bonsAI's to make, so M4 needs a different candidate.

**What it does demonstrate:** the rig found a real, previously unrecorded D-pad defect on its
own, distinguished it from a plugin bug by experiment, and produced a measurement rather than
an opinion — with nobody at the device.
