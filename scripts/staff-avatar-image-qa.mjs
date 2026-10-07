import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalizeStaffAvatarData, MAX_OUTPUT_BYTES, MAX_SIDE } from '../staff-avatar-image.js';

const source = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 95, g: 24, b: 46 } } }).png().toBuffer();
const normalized = await normalizeStaffAvatarData(`data:image/png;base64,${source.toString('base64')}`);
assert.match(normalized, /^data:image\/webp;base64,/);
const output = Buffer.from(normalized.slice(normalized.indexOf(',') + 1), 'base64');
const metadata = await sharp(output).metadata();
assert.equal(metadata.width, MAX_SIDE, 'normalized avatar must be the expected square width');
assert.equal(metadata.height, MAX_SIDE, 'normalized avatar must be center-cropped to a square');
assert.ok(output.length <= MAX_OUTPUT_BYTES, 'normalized image must stay within the storage budget');
assert.equal(metadata.exif, undefined, 'output must not retain EXIF metadata');

await assert.rejects(normalizeStaffAvatarData('data:image/png;base64,AA=='), { code: 'invalid_avatar' });
await assert.rejects(normalizeStaffAvatarData(`data:image/png;base64,${Buffer.alloc(1_500_001).toString('base64')}`), { code: 'invalid_avatar' });
await assert.rejects(normalizeStaffAvatarData(`data:image/jpeg;base64,${source.toString('base64')}`), { code: 'invalid_avatar' });

console.log(`STAFF AVATAR IMAGE QA: PASS (${metadata.width}x${metadata.height}, ${output.length} bytes WebP)`);
