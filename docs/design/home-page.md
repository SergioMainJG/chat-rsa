# Home page specification (Komwasai)

Source of truth for how `/` (`src/frontend/index.html` + `src/frontend/styles.css`) must look and read. It keeps the visual world of the mockup `img/design-landscape.png` and applies the fixes from the critique `.impeccable/critique/2026-11-14T08-16-56Z__img-design-landscape-png.md` (NN/g heuristics, 16/32 on the mockup).

Direction chosen by the owner: technical and honest. The page shows how the encryption works instead of only claiming it.

## 1. What stays from the mockup

- Deep indigo field across the whole page, off-white text, white pill buttons, a darker footer band.
- One left-aligned reading axis for headline, supporting text and the primary button.
- The geometric grotesk wordmark "Komwasai" as the brand moment, at a smaller size (see section 4).
- Product copy in Spanish, informal "tú" (tuteo), as in the mockup. `<html lang="es">`.

## 2. Tokens

Measured from the mockup; every text pair below already passes WCAG AA, keep them.

| Token                | Value     | Use                                                                   |
| -------------------- | --------- | --------------------------------------------------------------------- |
| `--color-field`      | `#150E60` | page and header background                                            |
| `--color-field-deep` | `#100A50` | footer background (no border: the old 1.09:1 border goes)             |
| `--color-ink`        | `#FDFFF4` | headline, body text on the field (16.4:1)                             |
| `--color-ink-muted`  | `#E1E0E9` | secondary text, footer descriptions (13.6:1); never italic            |
| `--color-surface`    | `#FFFFFF` | primary button fill, illustration panels                              |
| `--color-on-surface` | `#000000` | primary button label (21:1)                                           |
| `--color-accent`     | `#473DC6` | text and links on white surfaces (7.6:1)                              |
| `--color-ok`         | `#58F46C` | only for the "cifrado" state inside the illustration, never for prose |

Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64, 96 px. Radius: pills `999px`, panels `16px`. Focus ring: 3px `--color-ok` outline with 2px offset on every interactive element.

## 3. Typography

- One family: the system font, for display and text. Drop the monospace-like face used for "Crear cuenta"/"Entrar" and the separate face of the footer.
- The face is the platform's system font (`system-ui` stack in `styles.css`); no web font is loaded. Code and ciphertext use the platform monospace.
- Scale (fluid, `clamp()`):

| Role               | Size                                      | Weight | Notes                                 |
| ------------------ | ----------------------------------------- | ------ | ------------------------------------- |
| Wordmark (header)  | 24px                                      | 600    | text, not an image; links to `/`      |
| H1 value statement | `clamp(2.25rem, 1.5rem + 3vw, 4rem)`      | 500    | max 14 words, `text-wrap: balance`    |
| Lead paragraph     | `clamp(1.125rem, 1rem + 0.5vw, 1.375rem)` | 400    | max 60ch, `text-wrap: pretty`         |
| Button label       | 18px                                      | 600    |                                       |
| Body / footer      | 16px (footer links 15px minimum)          | 400    | the mockup's 13px footer text is gone |
| Section label      | 14px, uppercase, `letter-spacing: 0.08em` | 600    | footer column headings only           |

## 4. Layout (desktop, 1366x768 first viewport)

```
┌────────────────────────────────────────────────────────────────────┐
│ [Komwasai]                                   Entrar   [Crear cuenta]│  header, 72px
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  H1: Solo tú y tus contactos       │   ┌──────────────────────────┐ │
│  pueden leer tus mensajes.         │   │ illustration (section 6) │ │
│                                    │   │ "Hola" → a8F…3x → "Hola" │ │
│  Lead paragraph (2 lines)          │   └──────────────────────────┘ │
│                                    │                                │
│  [ Crear cuenta ]  ¿Ya tienes cuenta? Entrar                        │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ section 7: "Qué ve nuestro servidor" (two lists)                    │
├────────────────────────────────────────────────────────────────────┤
│ footer: brand + 3 headed columns                                    │
└────────────────────────────────────────────────────────────────────┘
```

- Content width `min(1200px, 100% - 2 * 24px)`, centered. Hero is a two-column grid `minmax(0, 6fr) minmax(0, 5fr)`, gap 64px, vertically centered, `min-height: calc(100svh - 72px)` capped at 760px.
- The left column holds H1, lead and actions on one left edge (the mockup's wordmark was 8-9px off that edge; nothing may break it now).
- The right column holds the illustration, filling the 536px that were empty in the mockup.
- The wordmark leaves the hero: it lives in the header at 24px. The H1 is the value statement, so the page's hierarchy is value, then action, then brand.

## 5. Header and calls to action

- Left: logo mark + wordmark "Komwasai" linking to `/`. The mark is `src/frontend/assets/isotipo-96.png` (the trimmed `public/isotipo.png`, shown at 32px); `public/favicon.svg` has an opaque black ground and stays a favicon only.
- Right: `Entrar` as a text link (to `/sign-in`), then `Crear cuenta` as the only pill in the header (to `/sign-up`). Both hit areas at least 44x44px (padding, not font size). The mockup's pill was 29px tall and "Entrar" had no hit area.
- Hero actions: one primary button `Crear cuenta` (`/sign-up`, white fill, black label, min 48px tall, 32px horizontal padding) followed by the text `¿Ya tienes cuenta?` and the link `Entrar` (`/sign-in`).
- Remove "Chatea ya!": it duplicated "Crear cuenta" without saying where it led. No other CTA competes in the first viewport.

## 6. Hero copy and illustration

Copy (exact strings):

- H1: `Solo tú y tus contactos pueden leer tus mensajes.`
- Lead: `Komwasai cifra cada mensaje en tu dispositivo antes de enviarlo. Nuestro servidor solo guarda texto cifrado que no puede leer.`
- Microline under the actions (muted, 14px): `Cifrado de extremo a extremo con X25519, HKDF-SHA256 y AES-256-GCM.`

Do not write "no sabemos nada de lo que hablas" or "sin almacenamiento de claves": the server does store metadata and public keys (section 7), and a privacy-literate visitor will check.

Illustration (right column), three stacked steps in one white panel, connected by a vertical line:

1. `Tu dispositivo` — a message bubble with the plain text `Hola, ¿nos vemos a las 8?`.
2. `Nuestro servidor` — the same bubble rendered as ciphertext (a monospace base64 string, e.g. `9fQ2…kL0x`), with the label `Solo ve esto`.
3. `El dispositivo de tu contacto` — the plain text again.

- Built as HTML + CSS (or inline SVG), no raster, no JS. Text in the illustration is real text, readable by screen readers; the panel is a `<figure>` with a `<figcaption>`: `Cómo viaja un mensaje: se cifra en tu dispositivo y solo se descifra en el de tu contacto.`
- Motion, the page's one authored moment: the ciphertext line in step 2 is revealed left to right on load (`clip-path` wipe, 1.2s, expo ease-out, 400ms delay). Wrapped in `@media (prefers-reduced-motion: no-preference)`; static otherwise.
- `--color-ok` marks only the lock state of step 2 (a small "cifrado" tag), never body text.
- No inline `style=` attributes or inline `<style>`/`<script>`: the CSP allows only the route-guard style hash. All styling goes in `styles.css`.

## 7. "Qué ve nuestro servidor" section

Below the hero, on the same field, an H2 `Qué ve nuestro servidor` and two lists side by side (stacked on mobile). This is the trust proof the mockup lacked; keep it factual and update it whenever the backend changes.

`Lo que no puede ver`:

- El contenido de tus mensajes (solo guarda el texto cifrado).
- Tus claves privadas: nunca salen de tu dispositivo.
- Lo que buscas: la búsqueda se hace en tu dispositivo.

`Lo que sí ve`:

- Tu nombre de usuario y quién está en cada sala.
- Los nombres de las salas.
- Cuándo se envía cada mensaje y hasta dónde lo leyó cada miembro.
- Tus claves públicas.
- Tu dirección IP mientras usas el servicio, para limitar abusos.

## 8. Footer

- Background `--color-field-deep`, no border, 64px top padding.
- First column: wordmark + one line `Mensajería cifrada de extremo a extremo.` (not italic, `--color-ink-muted`).
- Then up to three headed columns, links left-aligned, 15px, at least 44px row height on touch:
  - `Producto`: `Crear cuenta`, `Entrar`.
  - `Seguridad`: `Cómo funciona el cifrado` (anchor to section 7).
  - `Legal` (`Política de privacidad`, `Términos de servicio`) is added once those pages exist; today it is omitted.
- Ship a link only when its page exists. "Centro de ayuda", "Programa de referidos", the blog post, the organizations contact and "Auditoría de seguridad" come back only with real pages; an audit link must point to a published audit report.
- Drop the green "Todos los servicios protegidos" line: nothing measures it. Bring a status line back only if it reads a real health check.

## 9. Spanish copy rules

Spelling fixes from the mockup, applied wherever those strings appear: `¡Chatea ya!` (if ever used), `nuestro`, `contáctanos aquí`, `Mensajería`, `Política`, `Términos`, `Auditoría`, no double spaces, `es lo primero`. Tuteo everywhere (`tienes`, `tus`, `Entrar`). No gendered self-descriptions ("Estoy interesado"); name the thing ("Programa de referidos"). Never mention "RSA" (the cryptography is X25519).

## 10. Responsive behavior

- Below 900px: hero becomes one column (H1, lead, actions, then illustration). Below 600px the illustration steps stay stacked and full width.
- At 360px: header keeps the logo mark + `Entrar` + `Crear cuenta` (the wordmark text hides below 380px, where all three do not fit), 16px gutters, no horizontal scroll; the primary button is full width; the H1 lands at 36px and the primary button stays in the first viewport.
- Footer columns stack, each with its heading.

## 11. Accessibility and states

- One `h1`, then `h2` per section; landmarks `header`, `main`, `footer`; the illustration is a `figure`.
- Visible focus ring on every link and button (section 2); hover lifts nothing, it changes the fill (`--color-ink` text links underline on hover/focus).
- All text pairs from section 2 keep AA; recheck any new pair at 4.5:1 (3:1 for 24px+).
- The page works with JS disabled (it has none).

## 12. Icons and manifest

- Every page links `public/favicon.svg`, `favicon-32x32.png`, `favicon-16x16.png`, `apple-touch-icon.png` and `site.webmanifest` by relative path, so Bun bundles them with hashed names.
- The server also publishes those files and `favicon.ico` and `android-chrome-*.png` at the root (`src/backend/shared/http/public-assets.ts`), where browsers and the manifest look for them. `design-landscape.png` and the full-size `isotipo.png` are never published.
- The manifest names the app `Komwasai` with `theme_color` and `background_color` `#150E60`.

## 13. Acceptance checklist

- [ ] One primary action in the first viewport; "Chatea ya!" gone.
- [ ] H1 is the value statement; wordmark is 24px in the header.
- [ ] Right column shows the plaintext → ciphertext → plaintext illustration; no empty half.
- [ ] Section 7 lists what the server sees and does not see, matching the backend.
- [ ] No claim from the old mockup that the backend contradicts.
- [ ] System font only, no web font; nothing under 15px.
- [ ] Footer has headed columns and only links to pages that exist.
- [ ] Every touch target is at least 44x44px.
- [ ] Spanish copy has its accents and `¡`.
- [ ] CSP unchanged and `test/e2e/pages.csp.e2e.test.ts` passes; no inline styles or scripts.
- [ ] Re-run `/impeccable critique` on the implemented page; target 26/32 or more.
