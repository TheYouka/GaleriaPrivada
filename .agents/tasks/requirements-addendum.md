# Requirements addendum (confirmed by the user after the run started)

These requirements are as binding as the original brief. DESIGN.md and PLAN.md must incorporate them.

## 1. Profile deletion: password always required (DECISION CLOSED)

- A profile and its vault can only be deleted from inside the app by entering that profile's password.
- The app NEVER offers deleting, resetting or "forgot password" for a profile without its password. No hidden path, flag, CLI or confirmation dialog bypasses this.
- DESIGN.md should note, as a fact rather than a feature, that someone with OS access (for example an admin) can delete the vault folder manually. The app does not guide or help with this.
- This replaces the earlier "decision point" about profile deletion.

## 2. Switchable visual themes (NEW FEATURE)

The user wants to switch the whole app between 5 visual themes at will. They wrote "3 styles" but listed 5, so build 5:

| id | Inspired by | Key traits |
|---|---|---|
| `fotos` | Windows 11 Photos (Fluent) | Mica-like translucent surfaces, 8px rounded corners, light/dark, accent color, left navigation pane. Recommended default theme. |
| `xbox` | Xbox One dashboard (Metro/Fluent era) | Flat rectangular tiles of different sizes, strong focus highlight (scale + border), green accent, horizontal pivot/tab navigation, very keyboard/gamepad friendly. |
| `ps3` | PS3 XrossMediaBar (XMB) | Animated wave background (canvas/WebGL; color may follow time of day/month), horizontal category row with icons, vertical item list for the selected category, smooth focus glide. |
| `macos` | macOS (Sonoma/Sequoia, Photos for Mac) | Frosted vibrancy (backdrop-filter blur), sidebar, traffic-light style window controls on a frameless window with custom titlebar, light/dark. |
| `album` | Designer's choice: analog photo album | Warm paper texture, photos framed like instant prints with slight rotation, serif/handwritten-style headings, soft film-grain feel. Distinct from the other four. |

Requirements:

- **Architecture.** A theme is:
  - design tokens (CSS variables: colors, typography, radii, shadows, blur, spacing, motion curves and durations);
  - plus an optional layout shell variant (navigation pattern: sidebar, pivot/tabs, XMB, top bar);
  - plus an optional background renderer (static, Mica-like, animated waves, paper texture);
  - plus a motion preset.

  Business logic and components are shared. Themes must not fork features: every feature (gallery, search/filter/sort, selection, viewer, editor, player, playlists, presentation setup, dual video, settings, profile picker, unlock and lock) works in every theme.
- **Live switching.** Themes switch live without restarting, with a short crossfade. A theme picker shows a preview of each theme.
- **Profile picker.** Keep the Netflix/HBO-style structure (large avatars, name below, "Administrar perfiles") in all themes, restyled per theme. For example, `xbox` uses avatar tiles, `ps3` puts the avatars on the XMB wave background in a horizontal row, and `macos` looks like the login screen (round avatars over a blurred wallpaper). Flag this as a decision point with a recommendation.
- **Presentation and viewer.** The slideshow and full-screen viewer content stay theme-agnostic: transitions are their own setting. Only the surrounding chrome and controls are themed.
- **Persistence.** The theme choice is not vault content, so it is stored UNENCRYPTED: a global theme for the profile picker, plus an optional per-profile theme applied after unlock.
- **Accessibility.** Every theme meets WCAG AA contrast for text and controls, has a clearly visible keyboard focus, and respects `prefers-reduced-motion` (for example, the XMB waves become static).
- **Performance.** Animated backgrounds must be light on CPU and GPU. Pause them when the window is hidden or minimized, and during presentations and video playback.
- **Offline and legal.**
  - All fonts and assets are bundled locally; there is no CDN, because the app is offline.
  - Do not copy Microsoft, Sony or Apple logos, icons, sounds, wallpapers or proprietary fonts. Segoe UI and SF Pro are not redistributable, so use OFL/open alternatives such as Inter, Noto or Selawik.
  - Themes are "inspired by", not clones. Recommend neutral display names in the UI, with the internal ids above, in case the app is ever distributed. Flag this as a minor decision point.
- **Plan placement.** The theme system architecture (tokens, shell variants, switcher, persistence) and the default `fotos` theme must exist from Phase 1, because the profile screen is built there, so later screens are built theme-aware.
  - Recommendation: in Phase 1, also stub one radically different shell (`ps3` XMB) to validate the abstraction early.
  - Add a dedicated themes phase before the installers/E2E phase that completes `xbox`, `ps3`, `macos` and `album` across all screens, with visual verification (Playwright screenshots per theme).
  - The planner may refine this placement.

## 3. Threat model clarification and user rulings on design-review v2 findings (confirmed by the user before design round 3)

These rulings are binding. The designer must apply them in DESIGN.md (threat model, decisions table, revision history). The reviewer must NOT re-raise waived items as findings.

### Threat model

- The app is for PERSONAL use.
- The threat to defend against: someone who does not know the profile password opens the app, or accesses the vault files on disk, and obtains any vault data without logging in. Examples of "any vault data": photos, videos, thumbnails, names, dates, playlists.
- Everything that protects against that threat stays a priority:
  - the encryption and the file format;
  - locking (manual, inactivity, suspend, OS lock), with keys zeroed and the UI hidden immediately;
  - nothing decrypted written to disk BY THE APP ITSELF (temp files, caches, logs, libvips temp files, ffmpeg inputs);
  - no data reachable while locked;
  - the profile picker revealing nothing.
- Being 100% offline (no network) remains a requirement.

### Explicitly OUT OF SCOPE

These are expected behavior: the logged-in owner is acting deliberately.

- Dragging images or text out of the window to the desktop or another app, and copy/paste via the clipboard, while the user is logged in.
  - Do NOT add `dragstart` lockdown, `-webkit-user-drag: none`, `draggable={false}` rules, `user-select: none` or the related E2E tests.
  - Only list them as a known, accepted behavior in the limits section. Example wording: "if you drag or copy content out of the app, that copy lives outside the vault".
  - This waives review v2 finding 1 (HIGH) and finding 18 (LOW).
- A `will-download` handler that cancels downloads may remain as a one-line defense-in-depth, but it is not required and must not block approval.
- There is still NO export or "unhide" feature in the app.

### BMP

The user will not use BMP photos. Remove BMP from the supported import formats entirely. Supported photo formats are now JPG, PNG, WebP, GIF and AVIF.

- BMP files are rejected at import with UNSUPPORTED_FORMAT and their original is left untouched.
- This resolves review v2 finding 4. Drop `toSharpInput`, the ffmpeg BMP→PNG path, and the BMP rows in the edit, avatar and tests.
- Keep the avatar format and size limits from finding 4 (filter list without bmp, ≤ 50 MiB, ≤ 268 MP, sniffing, lstat).

### D18: auto-lock during long jobs

- **MERGES (confirmed by the user):** the inactivity timer is PAUSED while a dual-video merge is running.
- **IMPORTS (not yet confirmed):** apply the same pause while an import is running (outside awaiting-confirmation). Keep only this part flagged in the decisions table as "recomendada, pendiente de confirmar".
- **Both cases:** suspend, OS lock and manual lock still lock immediately and cancel the job.

### Still to fix in round 3

All other review v2 findings:

- **MEDIUM:** 2 (lock ordering: immediate veil, abort, bounded wait of 0 ms on suspend/os-lock, zeroize; keyless cleanup in background), 3 (WebRTC removal + dead local proxy), 5 (job concurrency/BUSY/duplicates state='ready'/music during move) and 6 (definition of `converted`).
- **LOW:** 7–17, 19 and 20.

Finding 10 (exit on remote-debugging switches in packaged builds) is directly relevant to "obtaining data without logging in": keep it.

## 4. User ruling on design review v3: design loop ENDED by the user (binding for the planner and scaffold)

The user ended the design loop after review v3 (CHANGES_REQUESTED: 0 HIGH, 3 MEDIUM, 8 LOW) and asked to move on to the plan.

- `design-verdict.json` stays CHANGES_REQUESTED on purpose.
- The planner must NOT treat that verdict as a blocker.
- The planner must NOT send the design back for another round.
- The remaining findings are handled in PLAN.md as described below.

Source: `.agents/tasks/design-review.md` (v3) and `.agents/tasks/design-verdict.json`.

### Review v3 finding 1: WAIVED, accepted risk

Finding 1 is the H.264 10-bit / 4:2:2 / 4:4:4 (and non-4:2:0 VP9/AV1) videos being stored as-is and then not playing in Chromium.

- The user only imports social-media downloads, not camera footage, and accepts this risk.
- Do NOT add the `videoAction(probe)` / COPYABLE_PIX pix_fmt check, or its tests and fixtures.
- Only add one line to the documented limits (DESIGN.md §24.2 and the in-app help), along the lines of: "algunos vídeos de cámara (H.264 de 10 bits o 4:2:2/4:4:4) podrían no reproducirse en Galería después de importarlos".
- It is a small, self-contained change if the user ever asks for it later.

### Review v3 findings 2–11: MANDATORY tasks in PLAN.md

Each finding gets its own task, using the reviewer's proposed fix, and each task has acceptance criteria and a test.

| Finding | Phase | Notes |
|---|---|---|
| 2 | SCAFFOLD | zod schemas live in `src/main/ipc/schemas.ts`, never imported by the preload. ESLint rule. `externalizeDeps: false` (or equivalent) for the preload build. E2E that invokes `app:getInfo` through the sandboxed preload. The scaffold step must implement this. |
| 3 | Phase 2, DATA-LOSS PROTECTION | `import:paths` uses the exact path as received, with NO NFC/trim normalization. Define path comparison against GaleriaData/vaultDir: case-insensitive on Windows, realpath, compare by segments. Tests with NFD names and trailing spaces, where the normalized variant also exists: the right file is imported and deleted. |
| 4 | Phase 2 (delete), Phase 4 (playlists) | Use `json_each(?)` with a JSON parameter instead of a huge `IN (...)`. Test with more than 32 766 ids. |
| 5 | SCAFFOLD / Phase 1 | Node egress guard also patches `dgram.Socket.prototype` and covers `process.binding`. Add `app.setProxy` + `configureHostResolver`. Document that it does not protect against malicious dependencies. |
| 6 | Phase 1 / Phase 2 | `getDb(epoch)` per session; `drained()` is awaited at unlock; deletions in the failure branch go through KeylessCleanup. |
| 7 | Phase 2 | Reconciliation lists the 256 thumbnail shards with `readdir` (or moves the work to the background) instead of one stat per thumbnail. |
| 8 | Phase 1 | Fix the IPC contract inconsistencies: what `profiles:delete` returns, where the `VAULT_UNAVAILABLE` path comes from, and which paths the renderer may see. |
| 9 | Phase 2 | `fetch-ffmpeg.mjs` detects the license with `ffmpeg -L` and copies the matching text (likely LGPL-3.0). |
| 10 | SCAFFOLD | Add `lib/errors-es.ts` and `themes/BackgroundHost.tsx` to the module tree. Vitest `resolve.alias` for `@shared` and `@renderer`. |
| 11 | Phase 2 | Reject CR3 (ftyp brand `crx `) as RAW. Reject tracks with no codec or no decoder with UNSUPPORTED_FORMAT. The original is left untouched in both cases. |

### Still pending confirmation (keep flagged in PLAN.md)

D18 for imports: pausing the inactivity timer during imports. The merge part is confirmed.

## 5. D11: Linux build location (decided by the user)

The user has no administrator rights on the Windows machine, so WSL2 is not available. This overrides the WSL2 recommendation in DESIGN.md §20.3 / R2.

**Where Linux is built.** Linux packages (AppImage and .deb) are built and tested on the user's own Linux PC. Workflow agents have no access to that PC, so Phase 7:

- prepares `scripts/linux-build.sh` and a "Compilar en Linux" section in the README;
- pauses so the user can run the script and share `release/linux-report.txt`.

**What `scripts/linux-build.sh` must do and produce:**

- run without `sudo`, assuming Node is installed in user space;
- `npm ci`;
- `fetch:ffmpeg --platform linux`;
- tests;
- E2E on the real desktop;
- `dist:linux`;
- GLib URI vectors.

**Moving the code.** The repo is copied with a USB drive or `git bundle`, not through any cloud service.

**Phase 2.** Linux-only test vectors (GLib) stay as `it.todo` in Phase 2 and are fixed in Phase 7 from the report.

**Alternatives.** GitHub Actions remains documented as an alternative only, and is not created.

## 6. User decisions after Phase 2 (binding)

- **D18 is fully CONFIRMED.** The inactivity timer stays paused during imports (except while awaiting confirmation) and during merges. Keep `IMPORT_PAUSES_AUTOLOCK = true`.
- **R6 / task 2.15 is CLOSED WITHOUT IMPLEMENTATION.** The user accepts the occasional ~0.1 s main-thread stall during large imports. Do NOT move import crypto/hashing to a `utilityProcess`. The DESIGN §3 invariant ("no utilityProcess") stays.
- **Phase 2 was tested manually by the user and works.**

## 7. User decisions after Phase 3 (binding)

- **D16 is CONFIRMED as option (a).** The presentation has a "silence videos" control plus a separate "Música de fondo" toggle next to it. Together they allow all four combinations:
  - only video audio (the default);
  - only background music;
  - both;
  - silence everything.
- **Phase 3 is accepted and committed.** These open LOW items stay as they are unless the user asks:
  - one click opens the viewer; selection uses Ctrl/Shift/checkbox/Space;
  - a damaged video shows the generic "No se puede reproducir este vídeo" message;
  - Esc during an edit save closes the editor (the recommended fix is to ignore Esc while saving; pending).

## 8. Theme change: `album` is replaced by a streaming-style theme (user decision, binding)

The user asked to replace the analog-photo-album theme. They first asked for a cyberpunk theme and then changed their mind: they want a streaming-service look inspired by HBO Max instead. NO cyberpunk. This overrides the `album` row of section 2 and DESIGN.md §15 for that theme only. The other four themes are unchanged.

| id | Visible name | Inspired by | Key traits |
|---|---|---|---|
| `cine` | Cine | Streaming apps (HBO Max style) | Dark only. Near-black surfaces with a violet-to-indigo gradient glow at the top. Violet accent with a lighter lavender for accent text; white text. Rounded poster-style cards that scale slightly on focus, with a bottom gradient and the name on a solid label. A top navigation bar. Large rounded profile avatars. One bold, friendly sans-serif. |

**Rules:**

- **Name and legal.**
  - The visible name stays neutral ("Cine"). The UI never says "HBO", "Max" or "Warner".
  - Do NOT copy logos, wordmarks, icons, fonts, artwork or sounds from HBO Max, Max, Warner Bros. Discovery or any other service. Everything is created for this project.
  - Colors are NOT restricted (user ruling): the palette may be as close to the service's as the user likes. A color on its own is not protected for this kind of use.
  - The font must be OFL and bundled locally: Plus Jakarta Sans. No CDN.
- **Id rename.**
  - `album` becomes `cine` in `THEME_IDS`, in the catalog (`schemes: ['dark']` only), in the types (`TitlebarKind` `'album'` → `'cine'`, `BackgroundKind` `'paper'` → `'gradient'`, `TileKind` `'polaroid'` → `'poster'`) and in tests.
  - The rename is safe because `album` was never available, so no settings file can contain it.
  - It is done in Phase 6 (task 6.1), NOT now. Phase 4 is still running and must not be disturbed.
- **Shell.**
  - A transparent top bar over the gradient that turns solid when the content scrolls. Sections on the left and the profile avatar on the right. It reuses `TopbarShell` with the same `NavModel` and the same screens.
  - The planner may adjust this, but the shell must not fork functionality.
  - The gallery stays the same virtualized grid grouped by date, with the same selection, search, filter and sort. Only the tile styling changes.
  - Optional, only if it forks no function and keeps the same data and actions: show Playlists as horizontal "shelves", one row per playlist with its first thumbnails. The planner decides.
- **Background.** A static CSS gradient (violet over near-black). No animation, so there is no performance cost and nothing to pause.
- **Motion.** Short scale and fade transitions of 200 to 250 ms. Under `prefers-reduced-motion`, scaling is replaced by the focus ring only, as in the other themes.
- **Accessibility.**
  - Text contrast is at least 4.5:1, and focus rings and component borders at least 3:1, verified by `theme-contrast.test.ts` over the two background extremes.
  - The violet accent must pass on the dark surfaces for any text; use the lighter lavender where it does not.
  - The focus ring is clearly visible (white), not only a color change or a scale.
  - Text over photos always sits on a solid label.
- **Profile picker (D9).**
  - This is the closest theme to the user's original "Netflix / HBO Max profile screen" request.
  - Same structure, DOM order and keyboard behavior as in the other themes.
  - Variant `showcase`: large rounded avatars on the gradient, the name below, and scale plus a white ring on focus.
- **Presentation and viewer.** Photo and video content are not tinted by the theme. Only the surrounding chrome is themed, as before.
- **Verification.** Phase 6 screenshots and the functional keyboard walkthrough cover `cine` like the other themes.
- **Open choices** (the planner recommends; the user may change later): the exact palette. Recommendation: background #09090F to #151030, accent violet #7C5CFF, lavender text accent #B7A6FF, focus ring white.

## 9. Gallery click rules (user decision after Phase 4, binding; supersedes PLAN.md note 145)

- **Opening an item is ALWAYS a DOUBLE CLICK**, in every mode. A single click never opens the viewer. Enter also opens the focused item (keyboard equivalent).
- **A single click anywhere on a tile toggles that item's selection.** The user must not have to aim at the checkbox.
  - Shift+click selects a range from the anchor.
  - Ctrl+click toggles.
  - Space toggles the focused item.
- **A double click must not leave the selection changed by its first click.** It opens the item and restores the selection to what it was before the first click. Do not delay single clicks to detect a double click, so single clicks stay responsive.
- **Selection bar and checkboxes:** the selection bar with its count appears as soon as one item is selected. Checkboxes are visible on all tiles while something is selected, and on hover or focus otherwise.
- **Leaving selection:** Esc, "Cancelar selección", or deselecting the last item.
- **Scope:** the same rules apply wherever tiles are selectable, including the playlist detail. Drag-to-reorder handles keep working.

## 10. User decisions after Phase 5 (binding)

The user decided the first point. For the rest, the user delegated the decision to the orchestrator ("las demás decisiones tómalas tú"). These decisions are the orchestrator's:

- **Merge output resolution is SELECTABLE (user).** The merge dialog offers "Automática (recomendada)", which is today's computed `H`, plus fixed output heights 360, 480, 720 and 1080 px.
  - `H` stays even and ≤ 1080.
  - Width follows from hstack of both inputs scaled to `H`.
  - Options above the tallest input are allowed but labelled "(amplía la imagen)".
  - The chosen resolution is part of the merge parameters. The identical-merge check (`existed: true`) only matches when the inputs AND the parameters, including the resolution, are the same.
  - The default is Automática.
- **`PlayerControls.tsx` (Phase 3) gets the same keyboard-scrub fix as the dual screen** (PLAN.md note 205): `scrub` is only stored during a pointer drag. Add a test.
- **`PlaceholderScreen.tsx` is deleted if nothing imports it.**
- **Horizontal next to vertical video in the dual screen:** no code change. It is left to the user's manual check.
- **D9 is CONFIRMED.** The profile picker keeps the same structure, DOM order and keyboard behavior in every theme; only the presentation changes.
- **D10 is CONFIRMED.** The visible theme names are neutral: Clásico (`fotos`), Mosaico (`xbox`), Ondas (`ps3`), Cristal (`macos`) and Cine (`cine`, which replaces `album`, see §8).
- **Cine palette.** Use the §8 recommendation (#09090F to #151030, violet #7C5CFF, lavender #B7A6FF, white focus ring). Colors are not restricted, but logos, names and fonts are.
- **Phase 6 visual verification.** Do NOT commit `toHaveScreenshot` reference images. They would add many MB to the public repo and are flaky across machines.
  - Use reviewed screenshots under `tests/.tmp/screenshots/fase-6/` instead.
  - Also run the keyboard-only functional walkthrough in all 5 themes and the automated contrast tests.
- **CPU measurement.** The background CPU measurement cannot be done with DevTools in `npm run dev` by the agents. Measure it in an E2E test instead, with `app.getAppMetrics()` / `process.getCPUUsage()`: waves visible vs paused. Record the numbers.
- **NVDA screen-reader check.** Optional manual check for the user. It does not block the phase.
