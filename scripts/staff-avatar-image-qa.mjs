import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalizeStaffAvatarData, MAX_OUTPUT_BYTES, MAX_SIDE } from '../staff-avatar-image.js';

const source = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 95, g: 24, b: 46 } } }).png().toBuffer();
const normalized = await normalizeStaffAvatarData(`data:image/png;base64,${source.toString('base64')}`);
assert.match(normalized, /^data:image\/webp;base64,/);
const output = Buffer.from(normalized.slice(normalized.indexOf(',') + 1), 'base64');
const metadata = await sharp(output).metadata();
assert.equal(metadata.width, MAX_SIDE, 'landscape avatar uses the maximum allowed width');
assert.equal(metadata.height, Math.round(MAX_SIDE * 900 / 1600), 'normalization preserves the source aspect ratio without cropping');
assert.ok(metadata.width <= MAX_SIDE && metadata.height <= MAX_SIDE, 'both dimensions stay within the avatar bounds');
assert.ok(output.length <= MAX_OUTPUT_BYTES, 'normalized image must stay within the storage budget');
assert.equal(metadata.exif, undefined, 'output must not retain EXIF metadata');

const smallSource = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#123456' } }).png().toBuffer();
const smallNormalized = await normalizeStaffAvatarData(`data:image/png;base64,${smallSource.toString('base64')}`);
const smallOutput = Buffer.from(smallNormalized.split(',')[1], 'base64');
const smallMetadata = await sharp(smallOutput).metadata();
assert.equal(smallMetadata.width, 80, 'small portrait is not enlarged');
assert.equal(smallMetadata.height, 120, 'small portrait preserves height and aspect ratio');
assert.ok(smallOutput.length <= MAX_OUTPUT_BYTES, 'small portrait also respects the storage budget');

await assert.rejects(normalizeStaffAvatarData('data:image/png;base64,AA=='), { code: 'invalid_avatar' });
await assert.rejects(normalizeStaffAvatarData(`data:image/png;base64,${Buffer.alloc(1_500_001).toString('base64')}`), { code: 'invalid_avatar' });
await assert.rejects(normalizeStaffAvatarData(`data:image/jpeg;base64,${source.toString('base64')}`), { code: 'invalid_avatar' });

console.log(`STAFF AVATAR IMAGE QA: PASS (${metadata.width}x${metadata.height}, ${output.length} bytes WebP)`);
