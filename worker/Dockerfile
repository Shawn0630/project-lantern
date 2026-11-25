# Python 3.13: WhisperJAV requires >=3.13,<3.14.
FROM python:3.13-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk git libsndfile1 build-essential \
    && rm -rf /var/lib/apt/lists/*
# fonts-noto-cjk: burn-in renders via libass/fontconfig; without a CJK font,
# Chinese subtitles come out as tofu boxes. Noto Sans CJK also covers Latin.
# git: pip installs WhisperJAV + faster-whisper from git URLs below.
# libsndfile1: soundfile (WhisperJAV audio I/O) needs it at runtime.
# build-essential: some WhisperJAV deps build native extensions.

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Torch CPU first: WhisperJAV's [cli] extra would otherwise pull the
# default (CUDA) torch/torchaudio wheels from PyPI. With these already
# installed at the pinned versions, pip accepts them and skips the CUDA
# builds. (CPU-only worker: no GPU in the container.)
RUN pip install --no-cache-dir torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cpu

# WhisperJAV (MIT) from git — it is not published on PyPI. [cli] brings
# the transcription stack (stable-ts fork, openai-whisper, VAD deps,
# librosa/scipy/numpy); the core faster-whisper pin above already matches.
RUN pip install --no-cache-dir "whisperjav[cli] @ git+https://github.com/meizhong986/WhisperJAV.git"

# Pre-cache the Silero VAD model WhisperJAV's stable-ts ASR downloads on
# first use (torch.hub, snakers4/silero-vad), so the first transcribe does
# not need to fetch it at runtime. Best-effort: a failed pre-cache must
# not break the build; the worker downloads it on first use instead.
RUN python -c "import torch; torch.hub.load('snakers4/silero-vad', 'silero_vad', trust_repo=True)" \
    || echo "VAD pre-cache failed (network?) - will download at runtime"

COPY worker.py gemini.py srt_utils.py burnin.py transcribe_core.py .

ENV MANAGER_URL=http://manager:9400 \
    WORKER_PORT=9500 \
    WHISPER_MODEL=large-v3 \
    HF_HOME=/models

EXPOSE 9500
CMD ["python", "worker.py"]
