'use strict';
/*
 * Transcoding adapter. If ffmpeg is available on the host, uploads are probed
 * for their real duration and (optionally) transcoded into HLS renditions for
 * adaptive streaming. If ffmpeg is missing, it degrades gracefully: the source
 * file is served as-is and the client-reported duration is kept.
 *
 *   FFMPEG_PATH   -> path to ffmpeg (default: "ffmpeg" on PATH)
 *   ENABLE_HLS=1  -> also generate HLS renditions (240/480/720p) in the background
 */
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const HLS = process.env.ENABLE_HLS === '1' || process.env.ENABLE_HLS === 'true';

function available() {
  try { return spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
}
const AVAILABLE = available();

// Real duration in seconds, or null if ffprobe isn't available / fails.
function probeDuration(filePath) {
  if (!AVAILABLE) return null;
  try {
    const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { encoding: 'utf8' });
    const d = parseFloat((r.stdout || '').trim());
    return Number.isFinite(d) ? Math.round(d) : null;
  } catch { return null; }
}

// Kick off HLS rendition generation in the background; returns the playlist path or null.
function transcodeHLS(filePath, outDir) {
  if (!AVAILABLE || !HLS) return null;
  fs.mkdirSync(outDir, { recursive: true });
  const master = path.join(outDir, 'master.m3u8');
  const args = [
    '-i', filePath,
    '-filter_complex', '[0:v]split=3[v1][v2][v3];[v1]scale=w=426:h=240[v1out];[v2]scale=w=854:h=480[v2out];[v3]scale=w=1280:h=720[v3out]',
    '-map', '[v1out]', '-c:v:0', 'libx264', '-b:v:0', '400k',
    '-map', '[v2out]', '-c:v:1', 'libx264', '-b:v:1', '1000k',
    '-map', '[v3out]', '-c:v:2', 'libx264', '-b:v:2', '2500k',
    '-var_stream_map', 'v:0 v:1 v:2',
    '-master_pl_name', 'master.m3u8',
    '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod',
    path.join(outDir, 'stream_%v.m3u8'),
  ];
  const p = spawn(FFMPEG, args, { stdio: 'ignore' });
  p.on('error', () => {});
  return master;
}

module.exports = {
  available: AVAILABLE,
  hls: AVAILABLE && HLS,
  probeDuration,
  transcodeHLS,
  info() { return { ffmpeg: AVAILABLE, hls: AVAILABLE && HLS }; },
};
