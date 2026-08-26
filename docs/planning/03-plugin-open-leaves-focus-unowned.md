# 03 — Opening a Decky plugin leaves gamepad focus unowned

Measured 2026-08-26 with `deck_readFocus` and the ESP32 bridge, on a live Deck, with nobody
touching the device. The first thing the rig characterised on its own.

**It is a platform behaviour, not a plugin bug, and on review it is not worth fixing either.**
Both conclusions took a correction to reach — see § 4. What is worth keeping is the
measurement, because tooling has to account for it.

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

**It resolves on the next D-pad press**, which places the ring on the plugin's topmost control
— the Back button. Confirmed independently by the maintainer from the device: first Down lands
on Back, second Down reaches the tab bar. That matches the reading here exactly (the first
press produced `<BUTTON>` with no text, which is the unlabelled Back icon).

So the press is **not** lost. It puts focus at the top of the plugin, which is a reasonable
place to start. An earlier draft of this document called it a "swallowed press"; that was
overstated and is corrected here.

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

## 4. Why this is not worth "fixing", and the correction that got here

The first version of this document recommended that plugins compensate by taking focus on
mount. The maintainer pushed back, correctly, and the recommendation is withdrawn.

The argument against compensating is stronger than the argument for it:

- **Every plugin behaves this way.** A plugin that grabs focus on open becomes the odd one out.
  Users build muscle memory across plugins, and being the only one that behaves differently is
  a worse experience than costing one press.
- **The press is not wasted.** It lands on Back, at the top of the plugin. That is a defensible
  default, not a broken state.
- **It is a permanent workaround for someone else's default**, which has to be carried forever
  and removed if Decky ever changes the behaviour.
- **Nobody has complained.** The maintainer has used this plugin daily for months without once
  filing it, which is real evidence about how much it matters.

**The one case where a plugin should act:** if you need the ring to start somewhere specific —
an ask bar, a primary action — nothing will place it there for you, so place it yourself. That
is an "if you need it" note, not a recommendation for every plugin.

---

## 5. Status

**Characterised, deliberately not fixed.** Any change belongs in Decky Loader, and per § 4 it
is not clearly worth making there either — the current behaviour is consistent and lands focus
somewhere sensible.

**The part that matters is for tooling.** A macro that opens a plugin must not assume its first
D-pad press moves anything; it should read focus first and acquire it if unowned. That is one
accommodation in the runner, and it is the reason this measurement is worth keeping at all.

**Not usable for bonsAI milestone M4** ("a D-pad bug is reproduced by script, fixed, and locked
by a check that fails without the fix"). The reproduce half is done and was cheap. The fix half
is not bonsAI's to make, so M4 needs a different candidate.

**What it does demonstrate:** the rig characterised an undocumented platform behaviour on its
own, distinguished it from a plugin bug by experiment, and produced a measurement rather than
an opinion — with nobody at the device. It did not, on its own, judge whether the behaviour was
worth changing. That took a human, and the human was right.
