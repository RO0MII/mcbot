# 2026-11-28 — RO0MII control cube hero loop

## Intent

The live page still advertises a “Rotating 3D MCBot control cube” in alt text, but the cube asset was deleted two commits ago. Replace the current `fleet-orbit.gif` with one premium, RO0MII-branded 3D loop that keeps the proof points visible: all 15 bots, 15 proxy IPs, zero collisions.

## Goals

- One animation only, used in both `README.md` and `docs/index.html`.
- A rotating control cube/core that reads as RO0MII, not a generic stock 3D shape.
- All 15 bots remain countable as small nodes orbiting or docked on the cube.
- On-screen readout: `MCBOT CONTROL`, `15 BOTS · 15 IPs · 0 COLLISIONS`.
- Seamless loop, lightweight enough for GitHub Pages, no external runtime assets.

## Non-goals

- No second animation and no return of the deleted `cube-3d.gif/.mp4`.
- No dashboard/panel code changes.
- No fleet restarts, no proxy changes, no bot state changes.

## Constraints

- Existing capture flow: deterministic `window.renderFrame(t)` page rendered headless and encoded with `ffmpeg`; keep the same 800×450, 15fps, ~4s loop format used by the current GIF.
- Keep the panel-only documentation rule: no terminal-bot section.
- GitHub Pages publishes `docs/` directly to `gh-pages`, so the new GIF must live under `docs/screenshots/`.
- Do not touch user-modified `dashboard/bot-options.js`, `dashboard/chat-text.js`, or untracked `dashboard/scoreboard-compat.js`.

## Approaches considered

1. **RO0MII control cube as the single hero loop** — chosen. Rebuilds the missing cube idea with brand styling and keeps all 15 bots. Replaces `fleet-orbit.gif`.
2. **Upgrade the fleet orbit** — would keep the existing composition but only restyle it; less directly fixes the broken cube promise.
3. **Add the cube as a second loop** — richer, but breaks the earlier “one animation only” decision and increases page weight.

## Design

A dark, near-black stage with a subtle violet/cyan rim light. At center, a beveled cube built from CSS 3D planes: brushed charcoal faces, thin cyan edge glows, a small `R` mark on the top face, and a soft floor reflection. Fifteen bot chips (numbered `01`–`15`) orbit on two tilted rings around the cube and briefly dock onto three visible face slots as the cube rotates. Below the cube, a compact glass readout shows `MCBOT CONTROL` and `15 BOTS · 15 IPs · 0 COLLISIONS`. The camera eases through one full cube rotation per loop; node motion and glow pulses return exactly to their starting state at the loop point.

Implementation is a throwaway HTML/CSS/JS scene at `/tmp/opencode/roomii-cube.html` with a deterministic `renderFrame(t)` function. Capture 60 frames through headless Chrome/CDP, encode to `docs/screenshots/roomii-control-cube.gif` with an `ffmpeg` palette pass, then replace both `fleet-orbit.gif` references and delete the unused `fleet-orbit.gif` and `fleet-orbit.mp4`. Update the project-page caption to name the cube. Verify locally in a browser, verify the committed Pages workflow and live asset status, and report the final fleet health unchanged.

## Left to builder

- Exact easing constants, glow intensity, and node spacing.
- Whether the `R` mark is a letter or a simple monogram; keep it text-based and local.
- Final GIF size target: prefer under 2.5 MB without obvious banding.
