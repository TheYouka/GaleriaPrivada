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
