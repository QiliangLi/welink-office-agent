# WeLink Office Agent UI Implementation Contract

## Scope

- This repository contains the WeLink Office Agent runtime and a desktop-first web console.
- UI implementation lives in `web-console/`.
- Product and visual specifications live in `lql_docs/`.
- The five PNG files in `design-reference/` are visual specifications, not runtime assets. Never embed them as page backgrounds or ship them in the UI bundle.
- The first UI milestone is mock-data only. Do not couple React components directly to runtime JSON files or add backend/API/SSE work unless a later task explicitly requests it.

## Required stack

- React + TypeScript + Vite.
- React Router for page navigation.
- Tailwind CSS for layout and utility styling, with shared design tokens defined in CSS variables.
- Lucide React for interface icons. Do not crop icons from the reference PNGs.
- Keep dependencies small. Do not add a state-management library until shared server state makes it necessary.

## Pages and routes

- `/` redirects to `/overview`.
- `/overview` renders the overview dashboard.
- `/tasks` renders the task list.
- `/tasks/new` renders the task creation workflow.
- `/tasks/:taskId` renders task detail.
- `/approvals` renders the human-approval queue.
- Activity, Artifacts, and Settings may appear in navigation as disabled or placeholder destinations, but must not pretend to be implemented.

## Architecture

- Reusable app chrome belongs in `src/components/shell/` and `src/layouts/`.
- Reusable domain UI belongs in `src/components/` and must be extracted only when it is shared or data-driven.
- Page-level composition belongs in `src/pages/`; pages should not contain duplicated shell markup.
- Domain models belong in `src/types/`. All five pages must use the same `Task`, `TaskStatus`, `Approval`, `PlanStep`, and `ActivityEvent` types.
- Mock content belongs in `src/mocks/`. Avoid hardcoding whole task trees directly in JSX.
- Small presentational helpers belong in `src/lib/`; avoid generic utility layers that obscure simple code.

## Visual rules

- Reconstruct the screenshots with real HTML and React components. Match hierarchy, proportions, spacing, density, and state emphasis rather than copying broken AI-generated text.
- Primary target: 1440px desktop. The UI must remain usable at 1280px, 1024px, 768px, 414px, 375px, and 320px.
- Use a cool lilac/slate substrate with a restrained flat violet accent. Do not use neon purple glow, gradient text, glassmorphism, pure `#fff`/`#000`, or hard grey card borders.
- Lock the radius scale, spacing scale, icon sizes, button variants, shadows, and status colors in shared tokens.
- Motion is feedback-only: page transitions, hover/focus feedback, progress updates, and one running-state pulse. Support `prefers-reduced-motion`.
- Use the vendored upstream GrokBot implementation for every Agent illustration. The SVG body, all 25 original expression coordinate sets, gaze/blink/morph loop, state motion, and six jelly quick actions come directly from `zhulin025/LaoA-GrokBot`; do not redraw, simplify, recolor, or add decorative parts. Product code may only adapt the React lifecycle, accessible label, sizing, and business-scene-to-upstream-state mapping. Each placement must use a semantically named scene with a restrained action whitelist; never rotate every action through every placement. Keep attribution and the MIT notice in `web-console/THIRD_PARTY_NOTICES.md`.
- Use semantic status colors consistently. Never communicate status by color alone; pair color with text and/or an icon.

## Product behavior

- The console must continuously answer: what the agent is doing, why it did it, what needs human action, and how to stop or continue.
- Running tasks expose a visible stop/pause control; do not hide it in an overflow menu.
- Approval cards must show action, impact, evidence/reason, and explicit approve/edit/reject controls.
- Partial, stopped, failed, waiting for external input, and waiting for approval are distinct states.
- Task detail plans are data-driven and show parent/child steps, current step, completed steps, waiting reasons, and timestamps.
- New Task is a consequential workflow: label fields, validate accessibly, preserve a draft locally, explain advanced choices, and confirm task creation with the consequence stated.

## Accessibility and responsive behavior

- Use semantic elements, accessible names, keyboard navigation, visible focus states, and labels linked to inputs.
- Body text and controls must meet WCAG AA contrast; touch targets are at least 44px.
- Apply `overflow-x: clip` to both `html` and `body`.
- Image-bearing grid tracks use `minmax(0, 1fr)`; flexible children that can overflow use `min-width: 0`.
- Button, tab, breadcrumb, and navigation labels must not wrap.
- At tablet widths, right rails become drawers or stacked sections. At mobile widths, the sidebar becomes a drawer and data tables become readable card rows instead of compressed columns.

## Quality gates

- Before handoff, run `npm run build`, `npm run lint`, and `npm run test` inside `web-console/`.
- Run the repository root tests with `npm test` when root files or runtime behavior change.
- Run `git diff --check` and inspect the final `git status`.
- Visually compare all five routes against their corresponding PNG at desktop size. Check sidebar width, topbar height, main-column width, card spacing, typography hierarchy, radii, border/shadow strength, state colors, and whitespace.
- Do not claim visual parity from static checks alone. State clearly whether the rendered pages were opened and inspected.

## Change discipline

- Preserve unrelated user changes and existing runtime behavior.
- Do not edit files in `design-reference/`.
- Prefer focused components over a single monolithic page, but avoid one-file-per-wrapper over-componentization.
- Keep visible Chinese copy natural and operational. Do not copy impossible dates, inconsistent task IDs, placeholder names, or malformed text from the reference images.
