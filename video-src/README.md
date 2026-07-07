# Launch video source

Deterministic, frame-exact motion graphics — `launch-video.html` exposes
`window.render(t)` which paints the exact frame for timestamp `t`.

Rebuild:
1. `node capture.js` — drives headless Chrome, seeks render(t) per frame, writes PNGs to `frames/`
2. `ffmpeg -y -framerate 30 -i frames/f%04d.png -c:v libx264 -pix_fmt yuv420p -crf 18 -preset slow -movflags +faststart constraintguard-launch.mp4`

Output: 1920×1080, 30fps, ~27s. No external assets, no audio.
