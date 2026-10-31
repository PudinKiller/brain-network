# Demo captures

- [Studio map](01-studio-map.png): all eight brains and three levels.
- [Hierarchy](02-hierarchy.png): the Accessibility card names both parents.
- [Owner gate](03-owner-gate.png): a review image loaded through the fixed lightbox.
- [60-second walkthrough](brain-network-60s.mp4): H.264, 1920 × 1080, 30 fps, no audio.

The walkthrough follows the supplied seven-shot schedule. It uses screenshots captured from the running fictional vault, short crossfades, gentle zooms, and a caption bar. The notes explicitly label agent history as fictional. Dispatch remained off.

To reproduce, keep demo-vault open and run `node tools/capture_demo.cjs verify`, then `node tools/capture_demo.cjs`. Render with `tools/render_clip.py` from an external Python environment containing imageio-ffmpeg. Keep that environment and raw captures in the sibling `.bn-tools` directory. Media binaries and environments stay outside the repository.
