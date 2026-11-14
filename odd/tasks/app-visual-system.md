# app-visual-system

Objective: apply the home page's visual system (docs/design/home-page.md) to sign-in, sign-up and chat, add CSS cross-document view transitions, and make every page work on mobile.
Branch: `feat/messages` (no git usage: the user owns git). Test runner: `bun test` (unit + e2e); visual check with headless Chromium at 1366x768 and 360px.

## Specs

- S1. "Ahora necesito que apliques los mismos principios a todas las demas paginas." Sign-in, sign-up and chat use the home's world: indigo field `#150E60`, off-white ink, white pills/panels, `#473DC6` accent, `#58F46C` only for the "encrypted/ok" state, 44px touch targets, visible `#58F46C` focus ring, themed selection/caret/scrollbar, honest copy. Copy stays in English on these pages (L2).
- S2. "Tambien aplica los view transitions con css". Every page opts in with `@view-transition { navigation: auto; }` (none under `prefers-reduced-motion: reduce`), shared in `styles.css`; the brand mark/name morphs between pages; `<link rel="expect" blocking="render">` on each page's above-the-fold content.
- S3. "de hecho crea versiones para movil basandose en este diseño final". Each page has a designed layout at 360px (no horizontal scroll, thumb-reachable primary action) and at tablet width.
- S4. "La fuente es la del sistema, asi que no importa". Use `system-ui`; remove Space Grotesk, its loader script and font files.

Assumptions: the guard pages keep their inline guard style and CSP hash unchanged; behavior, data attributes and JS hooks the scripts and tests rely on stay as they are (restyle, not re-architecture).

## Tasks

| ID  | Specs           | Route                           | Edit surface                                                                              | Status                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------- | ------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | S2, S4, S1 base | inline                          | src/frontend/styles.css, home.css, index.html, font files, spec, CLAUDE.md, home e2e test | done: shared base in styles.css (tokens, system font, header, buttons, @view-transition + reduced-motion off, brand morph), home.css trimmed, Space Grotesk + loader removed, home rel=expect; e2e RED left for T2/T3 (6: rel=expect + site header on /chat, /sign-in, /sign-up)                                                       |
| T2  | S1, S2, S3      | delegated (writer)              | src/frontend/auth/auth.css, sign-in.html, sign-up.html                                    | done (writer): site header, white form panel + aside (honest key/crypto lines), rel=expect #auth-panel, accent-filled primary on white, 44px controls, one column <900px; 4 RED -> GREEN; auth unit 25 pass; screenshots 1366/768/360 + invalid/busy                                                                                   |
| T3  | S1, S2, S3      | delegated (writer) + inline fix | src/frontend/messaging/chat.css, chat.html, chat.page.ts (parent: 2 lines)                | done: shared site header, rel=expect #rooms-title, accent/soft bubbles, drawn status icons, warning/danger banners, 44px controls, Manage room as overlay panel; <900px one pane with CSS #rooms-toggle; parent made openRoom uncheck the toggle so picking a room shows it (DOM glue, no unit test possible); messaging unit 253 pass |

Route evidence: T2 and T3 are independent units with disjoint edit surfaces and several minutes of work each (chat.css alone is 577 lines), launched together after T1 lands the shared base (Writer trigger (a), plus the long-session backstop).

## Log

- L1 (2026-11-14, user): "Ahora necesito que apliques los mismos principios a todas las demas paginas. Tambien aplica los view transitions con css, de hecho crea versiones para movil basandose en este iseño final. La fuente es la del sistema, asi que no importa"
- L2 (2026-11-14, user answer): language of sign-in, sign-up and chat = "Mantener inglés".
- L3 (2026-11-14): seam check: unit 686 pass, e2e 119 pass, lint and typecheck clean; `bun fmt --check` fails only on bugs/security.bug.md (not part of this feature). Visual spot check of /sign-up at 1366x768 and 360x780 by the parent.
