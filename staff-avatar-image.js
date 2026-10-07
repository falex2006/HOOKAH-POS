'use strict';

const sharp = require('sharp');

const MAX_INPUT_BYTES = 1_500_000;
const MAX_INPUT_PIXELS = 20_000_000;
const MAX_OUTPUT_BYTES = 80 * 1024;
const MAX_SIDE = 256;
const MIME_FORMATS = { 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };

async function normalizeStaffAvatarData(value) {
  const match = typeof value === 'string' && value.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw Object.assign(new Error('invalid_avatar'), { code: 'invalid_avatar' });

  const [, mime, encoded] = match;
  const input = Buffer.from(encoded, 'base64');
  if (!input.length || input.length > MAX_INPUT_BYTES || input.toString('base64') !== encoded) {
    throw Object.assign(new Error('invalid_avatar'), { code: 'invalid_avatar' });
  }

  try {
    const image = sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS, animated: false });
    const metadata = await image.metadata();
    if (metadata.format !== MIME_FORMATS[mime] || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_INPUT_PIXELS || metadata.pages > 1) {
      throw Object.assign(new Error('invalid_avatar'), { code: 'invalid_avatar' });
    }

    let output;
    for (const quality of [78, 68, 58, 48]) {
      output = await sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS, animated: false })
        .rotate()
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer();
      if (output.length <= MAX_OUTPUT_BYTES) break;
    }
    if (!output || output.length > MAX_OUTPUT_BYTES) throw Object.assign(new Error('avatar_too_large'), { code: 'avatar_too_large' });
    return `data:image/webp;base64,${output.toString('base64')}`;
  } catch (error) {
    if (error?.code === 'invalid_avatar' || error?.code === 'avatar_too_large') throw error;
    throw Object.assign(new Error('invalid_avatar'), { code: 'invalid_avatar' });
  }
}

module.exports = { normalizeStaffAvatarData, MAX_INPUT_BYTES, MAX_INPUT_PIXELS, MAX_OUTPUT_BYTES, MAX_SIDE };
