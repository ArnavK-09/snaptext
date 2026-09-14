# Snap Text — GNOME Shell Extension Audit & Optimization Report

Fork of `snaptext@cwittenberg` → `snaptext@ArnavK-09`.

Audit covers all shipped modules: `extension.js`, `ocr.js`, `dependencies.js`, `selection.js`, `smartextractor.js`, `smartmenu.js`, `smartpatterns.js`, `prefs.js`, `metadata.json`, and the GSettings schema.

---

## 1. Cleanup Log

Direct edits applied during Task 0 / Task 4 (safe, behavior-preserving except where a bug was being fixed):

| # | File | Change |
|---|------|--------|
| 1 | `dependencies.js` | Removed unused `gnome-screenshot` requirement. Screenshots are taken via the built-in `Shell.Screenshot`, not the binary. Removed it from `checkDependencies()`, all three distro install commands, and `packageDescriptions`. |
| 2 | `README.md` | Removed `gnome-screenshot` from the three install commands; updated the `gnome-extensions enable` command to the new UUID `snaptext@ArnavK-09`. |
| 3 | `ocr.js` | Removed dead `notifyErrorFn` constructor parameter and the unused `this._notifyError` field (never invoked anywhere). |
| 4 | `ocr.js` | Replaced synchronous `GdkPixbuf.Pixbuf.new_from_file()` (full-image decode on the main thread) with asynchronous `new_from_file_at_scale_async()` on a 64×64 thumbnail for brightness sampling. Added a channel-count guard so grayscale images do not produce `NaN` brightness. |
| 5 | `extension.js` | Updated `OcrProcessor` constructor call to match the new signature. |
| 6 | `smartmenu.js` | Updated `OcrProcessor` constructor call to match the new signature. |
| 7 | `extension.js` | `_notifyError()` now routes through `_showNotification()` (MessageTray) instead of the legacy `Main.notify()`, for consistency with the rest of the extension. |
| 8 | `prefs.js` | Moved the `shortcutLabel` declaration before the `changed::` settings callback that references it (temporal-dead-zone ordering). |
| 9 | `prefs.js` | Fixed the shortcut "double recording" bug: starting a second shortcut recording now cancels the first (shared `this._recordingStop` state). |

No changes were made to signal-connection topology, timer lifecycle, async/main-loop flow, or the public API.

---

## 2. Critical Issues

### C1 — Synchronous full-image decode on the main thread ✅ Fixed
- **Location:** `ocr.js` → `_analyzeImage()` (now `_readBrightness()`)
- **Type:** main-thread block
- **Description:** Brightness detection called `GdkPixbuf.Pixbuf.new_from_file()`, which synchronously decodes the entire PNG screenshot on the Shell main thread. For large selections (e.g. 4K), this could stall the compositor for 100 ms+ and drop frames during the OCR flow.
- **Impact:** UI lag / frame drops when capturing large areas; violates the "no synchronous blocking I/O" requirement.
- **Fix:** Replaced with `GdkPixbuf.Pixbuf.new_from_file_at_scale_async(path, 64, 64, true, cancellable, …)`. Brightness is now computed from a ≤64×64 thumbnail, decoded asynchronously off the main thread. Dimensions still come from the cheap header-only `get_file_info()`.

---

## 3. High Issues

### H1 — `gnome-screenshot` listed as a dependency it never uses ✅ Fixed
- **Location:** `dependencies.js` → `checkDependencies()` / `getCombinedInstallCommand()`
- **Type:** incorrect behavior
- **Description:** The extension captures the screen with the built-in `Shell.Screenshot` API. `gnome-screenshot` was never invoked, but the dependency check flagged it as missing, showing a "Missing dependency" dialog and install instructions for an unnecessary package.
- **Impact:** False error dialog that blocks usage and instructs users to install a redundant package.
- **Fix:** Removed `gnome-screenshot` from the check, all install commands, and the description table; reflected in `README.md`.

---

## 4. Medium Issues

### M1 — Shortcut recorder allows two simultaneous recordings ✅ Fixed
- **Location:** `prefs.js` → `_createShortcutRow()`
- **Type:** incorrect behavior
- **Description:** Recording state (`isRecording`) was per-row and independent. Clicking a second shortcut's record button without cancelling the first left both rows recording; the next key press would assign the same key to both shortcuts.
- **Impact:** User can silently overwrite one shortcut while trying to set another.
- **Fix:** Introduced shared `this._recordingStop` state. `startRecording()` now stops any previously active row first.

### M2 — Dead `notifyErrorFn` wiring in `OcrProcessor` ✅ Fixed
- **Location:** `ocr.js` → constructor / `extension.js` / `smartmenu.js`
- **Type:** dead code
- **Description:** `OcrProcessor` accepted a `notifyErrorFn` callback and stored it as `this._notifyError`, but never invoked it. Both callers passed a closure that was silently ignored.
- **Impact:** No functional bug (extension-level error handling still covers failures via "No text found" and the extraction `try/catch`), but misleading dead code.
- **Fix:** Removed the parameter/field and updated both call sites.

### M3 — Incorrect author attribution in the fork
- **Location:** `prefs.js` → About page (`label: _('by Christian Wittenberg')`, ko-fi / GitHub links) and `metadata.json` (`url`, `donations.kofi`)
- **Type:** incorrect attribution (fork)
- **Description:** The fork still credits the upstream author as the author and links to upstream's ko-fi and issue tracker. `metadata.json` `url`/`donations` also point to upstream.
- **Impact:** Misleading "About" page and donation/bug-report links for a personal fork.
- **Fix:** Flagged — requires a user decision (keep upstream credit vs. replace with fork author). Not changed automatically.

### M4 — `Main.notify()` legacy API ✅ Fixed
- **Location:** `extension.js` → `_notifyError()`
- **Type:** deprecated API / consistency
- **Description:** Errors used `Main.notify()`, inconsistent with the rest of the extension which uses `MessageTray.Notification`.
- **Fix:** `_notifyError()` now calls `_showNotification()`.

---

## 5. Low Issues

### L1 — `shortcutLabel` used before its declaration ✅ Fixed
- **Location:** `prefs.js` → `_createShortcutRow()`
- **Description:** The `changed::` callback referenced `shortcutLabel` (a `const`) declared later in the function. Worked at runtime (closure invoked after init) but was fragile/confusing.

### L2 — Busy-spinner race on rapid re-trigger
- **Location:** `extension.js` → `_extractTextAsync()` / `_setBusy()`
- **Description:** If the user triggers extraction twice in quick succession, the first run's `finally { _setBusy(false) }` can hide the spinner while the second run is still active. Cosmetic only (spinner disappears a moment early); no functional impact.
- **Fix:** Flagged — would require a busy counter; not worth the added state for a cosmetic issue.

### L3 — `clean_text` sanitizer is O(n³) worst case
- **Location:** `smartextractor.js` → `clean_text.sanitize()`
- **Description:** The "longest run of solid words" search uses three nested loops. For the small OCR fragments this extension processes (typically a single line, tens of tokens) it finishes well under 1 ms. Not on a keystroke/scroll path.
- **Fix:** Acceptable as-is; would only matter if this ever processed multi-paragraph documents.

### L4 — QR check runs a subprocess on every extraction
- **Location:** `ocr.js` → `_readQrCode()`
- **Description:** `zbarimg` is spawned for every OCR, even when the selection clearly has no QR code. It is async and cheap (~15 ms), but could be skipped for the "smart click" path where QR detection is rarely relevant.
- **Fix:** Design decision; left as-is.

---

## 6. GNOME Guideline Violations

### G1 — Fork name is not unique (REQUIRED for EGO upload)
- **Location:** `metadata.json` → `"name": "Snap Text"`
- **Problem:** The guidelines state: *"If it is a fork of another extension it MUST have a unique name to distinguish it."* The fork keeps the upstream display name.
- **Why it's a problem:** Would collide with the upstream extension on extensions.gnome.org and confuse users.
- **How to fix:** Choose a distinct name (e.g. "Snap Text (ArnavK-09 Fork)"). **Flagged — requires a user decision.**

### G2 — Legacy `Main.notify()` (minor) ✅ Fixed
- **Location:** `extension.js` → `_notifyError()`
- **Problem:** Legacy notification API, inconsistent with the MessageTray usage elsewhere.
- **How to fix:** Done — now uses `_showNotification()`.

### G3 — Untranslated author string is wrapped in `_()` (minor)
- **Location:** `prefs.js` → `_('by Christian Wittenberg')`
- **Problem:** Proper names should not be passed through gettext (and will be wrong once M3 is resolved).
- **How to fix:** Use a plain string. **Flagged** pending the M3 attribution decision.

All other guideline requirements were verified as compliant (see §8).

---

## 7. Background Safety Verdict

**Safe for background use.**

Checklist:
- ✅ All timers/signals cleaned up in `disable()` — `_extractTimeoutId`, `_selectionTimeoutId`, `connectObject` connections, keybindings, and subprocesses are all removed; no accumulation on re-enable.
- ✅ No synchronous blocking calls — all subprocess/network/file I/O is async (`wait_async`, `communicate_utf8_async`, `Soup`, `copy_async`, and now `new_from_file_at_scale_async`).
- ✅ Main thread never stalls — no busy loops or big computations in the UI path; brightness sampling is bounded to a 64×64 thumbnail.
- ✅ Memory does not grow unbounded — history is capped at 15 entries; `_activeProcesses` and language cache are bounded/cleared.
- ✅ Extension is idle-quiet — work is entirely user-triggered; no recurring `timeout_add` sources, so zero CPU when not in use.
- ✅ Network errors handled gracefully — translation failure falls back to the original text; no tight retry loop.
- ✅ Suspend/sleep — no recurring timers means suspend/resume has no effect; stale subprocesses are force-exited by `_stopActiveProcesses()` on the next trigger.

---

## 8. Guideline Compliance Checklist

| Requirement | Status |
|---|---|
| No work before `enable()`; `enable()`/`disable()` symmetric | ✅ Pass |
| Only static resources at module initialization | ✅ Pass (`LOCALE_TO_TESS`, regex patterns; `_langsCache` is a single cached string) |
| All created objects destroyed in `disable()` | ✅ Pass |
| All signals disconnected in `disable()` | ✅ Pass (uses `connectObject`/`disconnectObject`) |
| All main-loop sources removed in `disable()` | ✅ Pass |
| No deprecated modules (`Lang`, `Mainloop`, `ByteArray`) | ✅ Pass |
| No `Gtk`/`Gdk`/`Adw` in Shell process | ✅ Pass (only `prefs.js` imports them) |
| No `Clutter`/`Meta`/`St`/`Shell` in preferences | ✅ Pass |
| No interference with the extension system | ✅ Pass |
| Code not minified/obfuscated | ✅ Pass |
| No excessive logging | ✅ Pass (logging gated behind `enable-debug`, default off) |
| No forced `run_dispose()` | ✅ Pass |
| No bundled binaries; external tools spawned cleanly | ✅ Pass (`tesseract`, `mogrify`, `zbarimg` — necessary for OCR, dependency-checked) |
| Clipboard access declared in description | ✅ Pass ("copies it to your clipboard") |
| No default keyboard shortcuts shipped | ✅ Pass (GSettings defaults are `[]`) |
| `metadata.json` well-formed, no unnecessary keys | ✅ Pass |
| UUID format valid (`extension-id@namespace`, allowed chars) | ✅ Pass |
| `shell-version` only stable releases | ✅ Pass (45–50, all stable) |
| `session-modes` omitted for user-only mode | ✅ Pass |
| GSettings schema base ID/path correct; file named `<schema-id>.gschema.xml` | ✅ Pass |
| Fork has a unique `name` | ❌ Fail (see G1) |

---

*No `BUGS*.md` files were generated; the single `AUDIT_REPORT.md` is the final deliverable.*
