# Sarva — design system (web)

Source files for the **dark** Sarva control-plane look used by the live **`apps/web`** UI and static references.

| File                                             | Role                                                                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[tokens.css](tokens.css)`                       | CSS custom properties: color, type scale, radius, spacing, layout. Canonical names use `--sarva-`*; short aliases (`--bg`, `--accent`, …) align with earlier mock class names.                                                       |
| `[sarva-app.css](sarva-app.css)`                 | App shell and components. Imports `tokens.css`. Rules cover both legacy mock-style class names (`.banner`, `.card`, `aside nav a`, …) and prefixed names (`.sarva-banner`, `.sarva-card`, `.sarva-nav a`, …). |
| `[design-reference.html](design-reference.html)` | Static page to preview tokens and common components in a browser.                                                                                                                                                     |

## Consumption

- **From Vite / `apps/web`:** import or link `Design/sarva-app.css` according to your bundler layout.
- **From repo root or `Design/`:** `<link rel="stylesheet" href="Design/sarva-app.css" />` or `./sarva-app.css`.

Optional HTML reference mocks (if you keep them locally) typically live under **`Requirement/archive/mockups/`** — that path is **gitignored** in this fork; see root **`.gitignore`**.

## Fonts

**DM Sans** and **JetBrains Mono** are referenced from Google Fonts in `tokens.css` (`--sarva-font-sans` / `--sarva-font-mono`).
