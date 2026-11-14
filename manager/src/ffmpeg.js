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
  return {
    duration,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width || null,
    height: video?.height || null,
    format: info.format?.format_name || '',
  };
}

/** Extract 16 kHz mono WAV for ASR. */
export async function extractAudio(input, outWav) {
  await runCmd('ffmpeg', ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav]);
}

/** Cut a WAV chunk: [start, start+dur) — stream copy, sample-accurate for PCM WAV. */
export async function splitAudio(wav, start, dur, out) {
  await runCmd('ffmpeg', ['-y', '-ss', String(start), '-t', String(dur), '-i', wav, '-c', 'copy', out]);
}

/** Escape a path for ffmpeg's subtitles filter (escape : and '). */
export function escapeFilterPath(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** Burn ASS subtitles into the video (video re-encoded, audio copied). */
export async function burnIn(video, assFile, out, { crf = 20 } = {}) {
  const filter = `subtitles='${escapeFilterPath(assFile)}'`;
  await runCmd('ffmpeg', ['-y', '-i', video, '-vf', filter, '-c:v', 'libx264', '-crf', String(crf), '-c:a', 'copy', out]);
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
