const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';

const jobs = new Map();

function checkApiKey(req, res, next) {
  if (!API_KEY) return next();

  const key = req.headers['x-api-key'];

  if (key !== API_KEY) {
    return res.status(401).json({
      error: 'Unauthorized',
    });
  }

  next();
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url, {
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
}

async function getAudioDuration(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);

  const duration = parseFloat(stdout.trim());

  if (!Number.isFinite(duration)) {
    throw new Error('Unable to detect audio duration');
  }

  return duration;
}

async function renderVideo(jobId, payload) {
  const job = jobs.get(jobId);

  try {
    job.status = 'processing';

    const scenes = Array.isArray(payload.scenes)
      ? payload.scenes
      : [];

    let audioParts = [];

    if (Array.isArray(payload.audio_parts)) {
      audioParts = payload.audio_parts;
    } else if (payload.audio_url) {
      audioParts = [
        {
          part_index: 1,
          audio_url: payload.audio_url,
        },
      ];
    }

    if (scenes.length === 0) {
      throw new Error('No scenes were provided');
    }

    if (audioParts.length === 0) {
      throw new Error('No audio was provided');
    }

    const workDir = path.join('/tmp', `render-${jobId}`);
    fs.mkdirSync(workDir, { recursive: true });

    const imageFiles = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];

      if (!scene.image_url) {
        throw new Error(`Scene ${i + 1} has no image_url`);
      }

      const imagePath = path.join(
        workDir,
        `image_${String(i + 1).padStart(3, '0')}.jpg`
      );

      await downloadFile(scene.image_url, imagePath);

      imageFiles.push(imagePath);
    }

    const audioFiles = [];

    for (let i = 0; i < audioParts.length; i++) {
      const audio = audioParts[i];

      if (!audio.audio_url) {
        throw new Error(`Audio part ${i + 1} has no audio_url`);
      }

      const audioPath = path.join(
        workDir,
        `audio_${String(i + 1).padStart(3, '0')}.mp3`
      );

      await downloadFile(audio.audio_url, audioPath);

      audioFiles.push(audioPath);
    }

    let totalAudioDuration = 0;

    for (const audioFile of audioFiles) {
      totalAudioDuration += await getAudioDuration(audioFile);
    }

    const sceneDuration =
      totalAudioDuration / imageFiles.length;

    const imageListPath = path.join(workDir, 'images.txt');

    let imageList = '';

    for (const imageFile of imageFiles) {
      imageList += `file '${imageFile}'\n`;
      imageList += `duration ${sceneDuration}\n`;
    }

    imageList += `file '${imageFiles[imageFiles.length - 1]}'\n`;

    fs.writeFileSync(imageListPath, imageList);

    const slideshowPath = path.join(
      workDir,
      'slideshow.mp4'
    );

    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      imageListPath,

      '-vf',
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p',

      '-r',
      '30',

      '-c:v',
      'libx264',

      '-preset',
      'veryfast',

      '-movflags',
      '+faststart',

      slideshowPath,
    ]);

    let finalAudioInput;

    if (audioFiles.length === 1) {
      finalAudioInput = audioFiles[0];
    } else {
      const audioListPath = path.join(
        workDir,
        'audio.txt'
      );

      let audioList = '';

      for (const audioFile of audioFiles) {
        audioList += `file '${audioFile}'\n`;
      }

      fs.writeFileSync(audioListPath, audioList);

      const mergedAudioPath = path.join(
        workDir,
        'merged_audio.m4a'
      );

      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        audioListPath,

        '-c:a',
        'aac',

        '-b:a',
        '192k',

        mergedAudioPath,
      ]);

      finalAudioInput = mergedAudioPath;
    }

    const finalVideoPath = path.join(
      workDir,
      'final_video.mp4'
    );

    await execFileAsync('ffmpeg', [
      '-y',

      '-i',
      slideshowPath,

      '-i',
      finalAudioInput,

      '-c:v',
      'copy',

      '-c:a',
      'aac',

      '-b:a',
      '192k',

      '-shortest',

      '-movflags',
      '+faststart',

      finalVideoPath,
    ]);

    job.status = 'completed';
    job.outputPath = finalVideoPath;
    job.audioDuration = totalAudioDuration;
    job.sceneDuration = sceneDuration;

    setTimeout(() => {
      try {
        fs.rmSync(workDir, {
          recursive: true,
          force: true,
        });

        jobs.delete(jobId);
      } catch (error) {
        console.error('Cleanup error:', error);
      }
    }, 2 * 60 * 60 * 1000);

  } catch (error) {
    console.error(error);

    job.status = 'failed';
    job.error = error.message;
  }
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'n8n-ffmpeg-render',
  });
});

app.post('/render', checkApiKey, (req, res) => {
  const jobId = crypto.randomUUID();

  jobs.set(jobId, {
    status: 'queued',
    createdAt: new Date().toISOString(),
  });

  renderVideo(jobId, req.body);

  res.status(202).json({
    job_id: jobId,
    status: 'queued',
    status_url: `/status/${jobId}`,
    download_url: `/download/${jobId}`,
  });
});

app.get('/status/:jobId', checkApiKey, (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      error: 'Job not found',
    });
  }

  res.json({
    job_id: req.params.jobId,
    status: job.status,
    error: job.error || null,
    audio_duration: job.audioDuration || null,
    scene_duration: job.sceneDuration || null,
  });
});

app.get('/download/:jobId', checkApiKey, (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      error: 'Job not found',
    });
  }

  if (job.status !== 'completed') {
    return res.status(409).json({
      error: 'Video is not ready',
      status: job.status,
    });
  }

  res.download(
    job.outputPath,
    'final_video.mp4'
  );
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
