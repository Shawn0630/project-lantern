// ffmpeg/ffprobe helpers (spawned processes, promise-based).
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function probe(file) {
  const { stdout } = await runCmd('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const info = JSON.parse(stdout);
  const duration = Number(info.format?.duration || 0);
  const video = (info.streams || []).find((s) => s.codec_type === 'video');
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio');
  let fps = null;
  const fpsRaw = video?.avg_frame_rate || '';
  if (fpsRaw.includes('/')) {
    const [n, d] = fpsRaw.split('/').map(Number);
    if (d) fps = n / d;
  }
  return {
    duration,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width || null,
    height: video?.height || null,
    format: info.format?.format_name || '',
    fps,
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    audioBitrate: audio?.bit_rate ? Number(audio.bit_rate) : null,
  };
}

/** List keyframe timestamps (seconds) of the first video stream. */
export async function listKeyframes(file) {
  const { stdout } = await runCmd('ffprobe', [
    '-v', 'error', '-skip_frame', 'nokey', '-select_streams', 'v:0',
    '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file,
  ]);
  return stdout
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

/** Extract 16 kHz mono WAV for ASR. */
export async function extractAudio(input, outWav) {
  await runCmd('ffmpeg', ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav]);
}

/** Cut a WAV chunk: [start, start+dur) — stream copy, sample-accurate for PCM WAV. */
export async function splitAudio(wav, start, dur, out) {
  await runCmd('ffmpeg', ['-y', '-ss', String(start), '-t', String(dur), '-i', wav, '-c', 'copy', out]);
}

/** Cut a video segment with stream copy: [start, start+dur). */
export async function splitVideo(input, start, dur, out) {
  await runCmd('ffmpeg', ['-y', '-ss', String(start), '-i', input, '-t', String(dur), '-c', 'copy', out]);
}

/** Build the ffmpeg concat-demuxer list file content. */
export function concatListContent(files) {
  return files.map((f) => `file '${String(f).replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

/**
 * Verify all files share codec/resolution/fps with each other, and that
 * resolution/fps match the source video (a worker must never resize or
 * change the frame rate — concat requires identical parameters).
 * `probeFn` is injectable for tests.
 * @throws with the offending segment index and field on any mismatch.
 */
export async function checkConcatCompatible(files, sourceInfo, probeFn = probe) {
  if (!files || files.length === 0) throw new Error('no burn-in segments to concatenate');
  const infos = [];
  for (const f of files) infos.push(await probeFn(f));
  const reference = infos[0];
  if (!reference.hasVideo) throw new Error('burn-in segment 0 has no video stream — refusing to concatenate');
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    if (!info.hasVideo) throw new Error(`burn-in segment ${i} has no video stream — refusing to concatenate`);
    for (const [field, got, want] of [
      ['codec', info.videoCodec, reference.videoCodec],
      ['width', info.width, reference.width],
      ['height', info.height, reference.height],
    ]) {
      if (want != null && got !== want) {
        throw new Error(`burn-in segment ${i} has ${field} ${got}, expected ${want} — refusing to concatenate`);
      }
    }
    if (reference.fps != null && info.fps != null && Math.abs(info.fps - reference.fps) > 0.01) {
      throw new Error(`burn-in segment ${i} has fps ${info.fps}, expected ${reference.fps} — refusing to concatenate`);
    }
    if (sourceInfo) {
      for (const [field, got, want] of [
        ['width', info.width, sourceInfo.width],
        ['height', info.height, sourceInfo.height],
      ]) {
        if (want != null && got !== want) {
          throw new Error(`burn-in segment ${i} has ${field} ${got}, source video has ${want} — refusing to concatenate`);
        }
      }
      if (sourceInfo.fps != null && info.fps != null && Math.abs(info.fps - sourceInfo.fps) > 0.01) {
        throw new Error(`burn-in segment ${i} has fps ${info.fps}, source video has ${sourceInfo.fps} — refusing to concatenate`);
      }
    }
  }
}

/** Concatenate same-parameter video files (stream copy, no re-encode). */
export async function concatVideos(files, out) {
  const listPath = out + '.concat.txt';
  fs.writeFileSync(listPath, concatListContent(files));
  try {
    await runCmd('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out]);
  } finally {
    try { fs.unlinkSync(listPath); } catch { /* ignore */ }
  }
}

/** Mux an SRT as a soft subtitle track (mov_text). */
export async function muxSoft(video, srtFile, out, language = 'und') {
  await runCmd('ffmpeg', [
    '-y', '-i', video, '-i', srtFile,
    '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text',
    '-metadata:s:s:0', `language=${language}`, out,
  ]);
}

export function fileSize(p) {
  return fs.statSync(p).size;
}
