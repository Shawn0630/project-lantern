FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
# fonts-noto-cjk: burn-in renders via libass/fontconfig; without a CJK font,
# Chinese subtitles come out as tofu boxes. Noto Sans CJK also covers Latin.

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker.py gemini.py srt_utils.py burnin.py .

ENV MANAGER_URL=http://manager:9400 \
    WORKER_PORT=9500 \
    WHISPER_MODEL=large-v3 \
    HF_HOME=/models

EXPOSE 9500
CMD ["python", "worker.py"]
