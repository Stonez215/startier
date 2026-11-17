# Third-party code

- `ffmpeg/` — @ffmpeg/ffmpeg 0.12.15 (MIT), https://github.com/ffmpegwasm/ffmpeg.wasm
- `ffmpeg-core/` — @ffmpeg/core 0.12.10, FFmpeg compiled to WebAssembly (GPL-2.0-or-later).
  Source: https://github.com/ffmpegwasm/ffmpeg.wasm and https://ffmpeg.org/download.html

StarTier uses these only in the browser, to cut the first 30 seconds of a video (no re-encoding)
so artists get a preview clip automatically. These files are served from the website and are
not bundled into the iPhone or Android apps.
