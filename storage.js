'use strict';
/*
 * Storage adapter.
 *
 * Default: files live on local disk and are served from /uploads.
 * With S3 configured: each uploaded file is pushed to S3 and the LOCAL COPY IS
 * DELETED (so the app disk stays tiny), and public URLs point at S3 (or a CDN
 * if CDN_BASE_URL is set). This is what lets a video platform scale storage
 * without filling the host disk.
 *
 *   S3_BUCKET, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY  -> store files in S3
 *   CDN_BASE_URL (optional)                             -> serve via a CDN/CloudFront
 */
const fs = require('fs');

const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const CDN_BASE = (process.env.CDN_BASE_URL || '').replace(/\/$/, '');
const S3_ENABLED = !!(S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY);

let s3 = null;
if (S3_ENABLED) {
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({
      region: S3_REGION,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
    });
  } catch {
    console.warn('[storage] S3 env set but @aws-sdk/client-s3 not installed — staying on local disk.');
  }
}

// Public base for objects when no CDN is configured (virtual-hosted S3 URL).
const S3_BASE = s3 ? `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com` : null;

module.exports = {
  s3Enabled: !!s3,
  cdnEnabled: !!CDN_BASE,

  // Public URL for a stored filename: CDN first, then S3, else the local route.
  urlFor(filename) {
    if (!filename) return null;
    if (CDN_BASE) return `${CDN_BASE}/${filename}`;
    if (S3_BASE) return `${S3_BASE}/${filename}`;
    return `/uploads/${filename}`;
  },

  // Push a locally-saved file to S3, then delete the local copy to free the app
  // disk. Best-effort: on failure the local file is kept and logged for retry.
  async offload(localPath, filename, contentType) {
    if (!s3) return;
    try {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET, Key: filename,
        Body: fs.createReadStream(localPath), ContentType: contentType || 'application/octet-stream',
      }));
      fs.unlink(localPath, () => {}); // free the host disk once it's safely in S3
    } catch (e) {
      console.warn('[storage] S3 upload failed (kept local copy):', e.message);
    }
  },

  // Back-compat name used across the server.
  mirror(localPath, filename, contentType) { return this.offload(localPath, filename, contentType); },

  // Remove an object from S3 (called when a video/file is deleted).
  async remove(filename) {
    if (!s3 || !filename) return;
    try {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: filename }));
    } catch (e) {
      console.warn('[storage] S3 delete failed:', e.message);
    }
  },

  info() {
    return { s3: !!s3, cdn: !!CDN_BASE, bucket: s3 ? S3_BUCKET : null, region: S3_REGION, cdn_base: CDN_BASE || null };
  },
};
