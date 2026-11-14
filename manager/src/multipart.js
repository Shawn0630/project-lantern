// Streaming multipart/form-data parser (no dependencies).
// File parts stream to disk; text fields accumulate in memory (capped).
// Boundary matching is byte-exact: a boundary only counts when preceded
// by CRLF, so boundary-like bytes inside file content cannot split a part.

import fs from 'node:fs';

const MAX_FIELD_BYTES = 1024 * 1024; // 1 MB per text field
const MAX_FIELDS = 50;

/**
 * Parse a multipart request.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} boundary boundary token from the Content-Type header
 * @param {(fieldname: string, filename: string) => string} filePathFor called per file part; must return a writable path
 * @returns {Promise<{ fields: Record<string, string>, files: Array<{ fieldname: string, filename: string, path: string, size: number }> }>}
 */
export function parseMultipart(req, boundary, filePathFor) {
  return new Promise((resolve, reject) => {
    const dashBoundary = Buffer.from('--' + boundary);
    const fields = {};
    const files = [];
    let fieldCount = 0;

    let buf = Buffer.alloc(0);
    let state = 'boundary'; // boundary | headers | field | file | done
    let headers = '';
    let currentField = null;
    let currentFile = null;
    let fileStream = null;
    let fileSize = 0;
    let finished = false;

    const fail = (err) => {
      if (finished) return;
      finished = true;
      try { fileStream?.destroy(); } catch { /* ignore */ }
      reject(err);
    };

    const parseHeaders = (raw) => {
      const out = {};
      for (const line of raw.split('\r\n')) {
        const idx = line.indexOf(':');
        if (idx > 0) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      return out;
    };

    const startPart = () => {
      const h = parseHeaders(headers);
      const disp = h['content-disposition'] || '';
      const nameMatch = /name="([^"]*)"/.exec(disp);
      const fileMatch = /filename="([^"]*)"/.exec(disp);
      const fieldname = nameMatch ? nameMatch[1] : '';
      if (!fieldname) throw new Error('multipart part without a name');
      if (fileMatch) {
        const filename = fileMatch[1].split(/[\\/]/).pop();
        const path = filePathFor(fieldname, filename);
        fileStream = fs.createWriteStream(path);
        fileStream.on('error', fail);
        currentFile = { fieldname, filename, path, size: 0 };
        files.push(currentFile);
        fileSize = 0;
        state = 'file';
      } else {
        if (++fieldCount > MAX_FIELDS) throw new Error('too many form fields');
        currentField = { name: fieldname, chunks: [], size: 0 };
        state = 'field';
      }
    };

    const feedField = (data) => {
      currentField.size += data.length;
      if (currentField.size > MAX_FIELD_BYTES) throw new Error('form field too large');
      currentField.chunks.push(data);
    };

    const feedFile = (data) => {
      fileSize += data.length;
      currentFile.size = fileSize;
      if (!fileStream.write(data)) {
        // Backpressure: pause the request until the stream drains.
        req.pause();
        fileStream.once('drain', () => req.resume());
      }
    };

    const endPart = async () => {
      if (state === 'field' && currentField) {
        fields[currentField.name] = Buffer.concat(currentField.chunks).toString('utf8');
        currentField = null;
      } else if (state === 'file' && currentFile) {
        await new Promise((res, rej) => {
          fileStream.end((err) => (err ? rej(err) : res()));
        });
        fileStream = null;
        currentFile = null;
      }
      // The boundary token itself was already consumed; what follows is
      // either "--" (end of body) or CRLF + the next part's headers.
      state = 'afterBoundary';
    };

    // Scan `buf` for the next boundary. Returns the index of the CRLF that
    // precedes the boundary, or -1 when the buffer holds no complete boundary.
    // A trailing partial boundary is kept in the buffer (return value -2).
    const findBoundary = () => {
      const idx = buf.indexOf(dashBoundary);
      if (idx === -1) {
        // Keep a tail that could be the start of a split boundary.
        const keep = Math.min(buf.length, dashBoundary.length + 4);
        return { idx: -1, keep };
      }
      return { idx, keep: 0 };
    };

    const process = async () => {
      try {
        for (;;) {
          if (state === 'boundary') {
            const { idx, keep } = findBoundary();
            if (idx === -1) {
              if (keep > 0 && buf.length > keep) {
                // No boundary in sight; but we are between parts, so any
                // data here is preamble/epilogue — drop it.
                buf = buf.subarray(buf.length - keep);
              }
              return;
            }
            // Expect CRLF before the boundary except at the very start.
            buf = buf.subarray(idx + dashBoundary.length);
            state = 'afterBoundary';
          } else if (state === 'afterBoundary') {
            if (buf.length < 2) return; // wait for the -- or CRLF that follows
            if (buf.subarray(0, 2).toString() === '--') {
              state = 'done';
              finished = true;
              resolve({ fields, files });
              return;
            }
            if (buf.subarray(0, 2).toString() === '\r\n') {
              buf = buf.subarray(2);
              state = 'headers';
              headers = '';
            } else {
              throw new Error('malformed multipart boundary');
            }
          } else if (state === 'headers') {
            const end = buf.indexOf('\r\n\r\n');
            if (end === -1) {
              if (buf.length > 64 * 1024) throw new Error('multipart headers too large');
              return;
            }
            headers = buf.subarray(0, end).toString('utf8');
            buf = buf.subarray(end + 4);
            startPart();
          } else if (state === 'field' || state === 'file') {
            const { idx, keep } = findBoundary();
            if (idx === -1) {
              const emit = buf.length > keep ? buf.subarray(0, buf.length - keep) : Buffer.alloc(0);
              if (emit.length > 0) {
                if (state === 'field') feedField(emit);
                else feedFile(emit);
              }
              buf = keep > 0 ? buf.subarray(buf.length - keep) : Buffer.alloc(0);
              return;
            }
            // Content ends at the CRLF preceding the boundary.
            let contentEnd = idx;
            if (contentEnd >= 2 && buf[contentEnd - 2] === 13 && buf[contentEnd - 1] === 10) {
              contentEnd -= 2;
            }
            const data = buf.subarray(0, contentEnd);
            if (data.length > 0) {
              if (state === 'field') feedField(data);
              else feedFile(data);
            }
            buf = buf.subarray(idx + dashBoundary.length);
            await endPart();
          } else if (state === 'done') {
            return;
          }
        }
      } catch (err) {
        fail(err);
      }
    };

    // Serialize chunk handling: process() awaits fileStream.end(), so
    // overlapping data events must not run it concurrently.
    let queue = Promise.resolve();
    const enqueue = (fn) => {
      queue = queue.then(fn).catch(fail);
    };

    req.on('data', (chunk) => {
      if (finished) return;
      enqueue(async () => {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
        await process();
      });
    });
    req.on('end', () => {
      enqueue(async () => {
        if (finished) return;
        // A well-formed body ends with --boundary-- which resolves above.
        // If we get here without it, the body was truncated.
        fail(new Error('truncated multipart body'));
      });
    });
    req.on('error', fail);
  });
}
