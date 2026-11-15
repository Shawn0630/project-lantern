import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parseMultipart } from '../src/multipart.js';

function multipartBody(boundary, parts) {
  // parts: [{ name, filename?, contentType?, body: Buffer|string }]
  const chunks = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head));
    chunks.push(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function fakeReq(bodyBuffer, chunkSize = 7) {
  // Split the body into tiny chunks to exercise boundary-splitting.
  const chunks = [];
  for (let i = 0; i < bodyBuffer.length; i += chunkSize) {
    chunks.push(bodyBuffer.subarray(i, Math.min(i + chunkSize, bodyBuffer.length)));
  }
  return Readable.from(chunks);
}

test('parses fields and a text file', async () => {
  const boundary = '----testboundary1234';
  const body = multipartBody(boundary, [
    { name: 'sourceLang', body: 'en' },
    { name: 'chunkMin', body: '10' },
    { name: 'video', filename: 'clip.mp4', contentType: 'video/mp4', body: 'FAKEVIDEO-DATA' },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-mp-'));
  const { fields, files } = await parseMultipart(fakeReq(body), boundary, (field, filename) => {
    const p = path.join(dir, filename);
    return p;
  });
  assert.deepEqual(fields, { sourceLang: 'en', chunkMin: '10' });
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'clip.mp4');
  assert.equal(fs.readFileSync(files[0].path, 'utf8'), 'FAKEVIDEO-DATA');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('binary content containing boundary-like bytes survives', async () => {
  const boundary = '----testboundary1234';
  // File bytes include a partial boundary and CRLFs — only a full
  // CRLF + --boundary sequence may split a part.
  const bin = Buffer.concat([
    Buffer.from([0x00, 0x01, 0x02, 0x0d, 0x0a]),
    Buffer.from('----testboundary12'), // partial boundary, no match
    Buffer.from([0xff, 0xfe, 0x0d, 0x0a, 0x2d, 0x2d]),
    Buffer.from('tail'),
  ]);
  const body = multipartBody(boundary, [
    { name: 'video', filename: 'a.bin', contentType: 'application/octet-stream', body: bin },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-mp-'));
  const { files } = await parseMultipart(fakeReq(body, 5), boundary, (field, filename) => path.join(dir, filename));
  assert.equal(files.length, 1);
  assert.deepEqual(fs.readFileSync(files[0].path), bin);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('truncated body rejects', async () => {
  const boundary = '----testboundary1234';
  const full = multipartBody(boundary, [{ name: 'video', filename: 'a.bin', body: 'data' }]);
  const cut = full.subarray(0, full.length - 10);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-mp-'));
  await assert.rejects(
    parseMultipart(fakeReq(cut), boundary, (field, filename) => path.join(dir, filename)),
    /truncated/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
