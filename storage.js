'use strict';
/*
 * Storage adapter. Videos/thumbnails are written to local disk by default, but
 * if S3 env vars are present the file is ALSO mirrored to S3 and served from a
 * CDN base URL. This keeps the app working locally while being one config away
 * from real cloud delivery.
 *
 *   S3_BUCKET, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY  -> enable S3 upload
 *   CDN_BASE_URL                                        -> serve files from a CDN
 */
const fs = require('fs');
const path = require('path');

const S3_BUCKET = process.env.S3_BUCKET;
const CDN_BASE = (process.env.CDN_BASE_URL || '').replace(/\/$/, '');
const S3_ENABLED = !!(S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY);

let s3 = null;
if (S3_ENABLED) {
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({
      region: process.env.S3_REGION || 'us-east-1',
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
    });
  } catch {
    console.warn('[storage] S3 env set but @aws-sdk/client-s3 not installed — staying on local disk.');
  }
}

module.exports = {
  s3Enabled: !!s3,
  cdnEnabled: !!CDN_BASE,

  // Public URL for a stored filename (CDN if configured, else the local route).
  urlFor(filename) {
    if (!filename) return null;
    return CDN_BASE ? `${CDN_BASE}/${filename}` : `/uploads/${filename}`;
  },

  // Mirror a locally-saved file to S3 (best-effort; local copy stays as fallback).
  async mirror(localPath, filename, contentType) {
    if (!s3) return;
    try {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET, Key: filename,
        Body: fs.createReadStream(localPath), ContentType: contentType || 'application/octet-stream',
      }));
    } catch (e) {
      console.warn('[storage] S3 mirror failed:', e.message);
    }
  },

  info() {
    return { s3: !!s3, cdn: !!CDN_BASE, bucket: s3 ? S3_BUCKET : null, cdn_base: CDN_BASE || null };
  },
};
