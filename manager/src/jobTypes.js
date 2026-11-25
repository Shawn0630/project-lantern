// Job-type registry: the single source of truth for what a job type
// needs. The UI renders its form from this schema (GET /api/job-types)
// and the upload endpoint validates against it, so adding a new job
// type later is a data change here, not a UI rewrite.
//
// Field kinds:
//   file     - a file upload (multipart field `key`)
//   select   - dropdown; options are { value, label }
//   number   - numeric input; min/max/step bound it
//   checkbox - on/off toggle; default is boolean
//
// A type's `fields` use the same multipart field names the pipeline
// already expects, so existing job creation is unchanged.

// Transcription engines: the single source of truth for the engine
// select in the job form, job-config validation, and the per-worker
// engine pin. faster-whisper is the default; whisperjav is WhisperJAV's
// stable-ts ASR (its balanced pipeline yields no word timestamps, so it
// is not offered — see worker/transcribe_core.py).
export const TRANSCRIPTION_ENGINES = [
  { value: 'faster-whisper', label: 'faster-whisper' },
  { value: 'whisperjav', label: 'WhisperJAV' },
];
export const DEFAULT_ENGINE = 'faster-whisper';

export const JOB_TYPES = [
  {
    id: 'video-translation',
    name: 'Video translation',
    fields: [
      { key: 'video', label: 'Video', kind: 'file', accept: 'video/*,audio/*', required: true },
      {
        key: 'sourceLang', label: 'Source language', kind: 'select', default: 'auto',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'en', label: 'English' },
          { value: 'zh', label: 'Chinese' },
          { value: 'ja', label: 'Japanese' },
          { value: 'ko', label: 'Korean' },
          { value: 'es', label: 'Spanish' },
          { value: 'fr', label: 'French' },
          { value: 'de', label: 'German' },
        ],
      },
      {
        key: 'targetLang', label: 'Target language', kind: 'select', default: 'zh-CN',
        options: [
          { value: 'zh-CN', label: 'Chinese (Simplified)' },
          { value: 'en', label: 'English' },
          { value: 'ja', label: 'Japanese' },
          { value: 'ko', label: 'Korean' },
          { value: 'es', label: 'Spanish' },
          { value: 'fr', label: 'French' },
          { value: 'de', label: 'German' },
        ],
      },
      {
        key: 'engine', label: 'Transcription engine', kind: 'select', default: 'faster-whisper',
        options: TRANSCRIPTION_ENGINES,
      },
      {
        key: 'model', label: 'Whisper model', kind: 'select', default: 'large-v3',
        options: [
          { value: 'tiny', label: 'tiny' },
          { value: 'base', label: 'base' },
          { value: 'small', label: 'small' },
          { value: 'medium', label: 'medium' },
          { value: 'large-v3', label: 'large-v3' },
          { value: 'large-v3-turbo', label: 'large-v3-turbo' },
        ],
      },
      { key: 'chunkMin', label: 'Chunk minutes', kind: 'number', default: 10, min: 0.5, max: 120, step: 0.5 },
      { key: 'overlapSec', label: 'Overlap seconds', kind: 'number', default: 10, min: 0, max: 120, step: 1 },
      { key: 'burnChunkMin', label: 'Burn chunk minutes', kind: 'number', default: 5, min: 0.5, max: 120, step: 0.5 },
      { key: 'translate', label: 'Translate', kind: 'checkbox', default: true },
      { key: 'burnIn', label: 'Burn-in subtitles', kind: 'checkbox', default: true },
      { key: 'bilingual', label: 'Bilingual subtitles', kind: 'checkbox', default: false },
    ],
  },
];

export function getJobType(id) {
  return JOB_TYPES.find((t) => t.id === id) || null;
}

export function listJobTypes() {
  return JOB_TYPES;
}
