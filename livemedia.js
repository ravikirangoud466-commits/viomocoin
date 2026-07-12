'use strict';
/*
 * Live media-server adapter. Real cross-viewer live video needs an ingest +
 * distribution server (LiveKit, Mux, Cloudflare Stream, or a plain RTMP+HLS
 * stack). This adapter issues broadcaster ingest credentials and viewer
 * playback URLs when configured; otherwise it returns null and the app falls
 * back to the built-in browser-camera preview + chat.
 *
 *   LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET   (WebRTC), or
 *   RTMP_INGEST_URL + HLS_PLAYBACK_BASE                  (RTMP -> HLS)
 */
const crypto = require('crypto');

const LIVEKIT = !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
const RTMP = !!(process.env.RTMP_INGEST_URL && process.env.HLS_PLAYBACK_BASE);

module.exports = {
  enabled: LIVEKIT || RTMP,
  provider: LIVEKIT ? 'livekit' : RTMP ? 'rtmp' : null,

  // Ingest details the broadcaster's encoder / browser uses to publish.
  ingestFor(stream) {
    if (LIVEKIT) {
      // A short-lived join token would be minted with the LiveKit SDK in production.
      return { provider: 'livekit', url: process.env.LIVEKIT_URL, room: 'live_' + stream.id, token: '<mint-with-livekit-sdk>' };
    }
    if (RTMP) {
      const key = 'live_' + stream.id + '_' + crypto.randomBytes(4).toString('hex');
      return { provider: 'rtmp', url: process.env.RTMP_INGEST_URL, stream_key: key };
    }
    return null;
  },

  // Playback URL viewers use to watch the stream.
  playbackFor(stream) {
    if (LIVEKIT) return { provider: 'livekit', url: process.env.LIVEKIT_URL, room: 'live_' + stream.id };
    if (RTMP) return { provider: 'hls', url: `${process.env.HLS_PLAYBACK_BASE.replace(/\/$/, '')}/live_${stream.id}.m3u8` };
    return null;
  },

  info() { return { enabled: LIVEKIT || RTMP, provider: LIVEKIT ? 'livekit' : RTMP ? 'rtmp' : null }; },
};
