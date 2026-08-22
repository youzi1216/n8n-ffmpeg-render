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

const BASE_DIR = '/tmp/n8n-render';
const JOB_DIR = path.join(BASE_DIR, 'jobs');
const OUTPUT_DIR = path.join(BASE_DIR, 'outputs');

fs.mkdirSync(JOB_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function jobFile(jobId) {
  return path.join(JOB_DIR, `${jobId}.json`);
}

function saveJob(jobId, data) {
  fs.writeFileSync(
    jobFile(jobId),
    JSON.stringify(data, null, 2)
  );
}

function loadJob(jobId) {
  const file = jobFile(jobId);

  if (!fs.existsSync(file)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function updateJob(jobId, changes) {
  const current = loadJob(jobId) || {};
  const updated = {
    ...current,
    ...changes,
    updatedAt: new Date().toISOString(),
  };

  saveJob(jobId, updated);
  return updated;
}

function checkApiKey(req, res, next) {
  if (!API_KEY) {
    return next();
  }

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

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  fs.writeFileSync(outputPath, buffer);
}

async function getAudioDuration(filePath) {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]
  );

  const duration = parseFloat(stdout.trim());

  if (!Number.isFinite(duration)) {
    throw new Error('Unable to detect audio duration');
  }

  return duration;
}

async function mergeAudio(audioFiles, workDir) {
  if (audioFiles.length === 1) {
    return audioFiles[0];
  }

  const listPath = path.join(
    workDir,
    'audio-list.txt'
  );

  const mergedPath = path.join(
    workDir,
    'merged-audio.m4a'
  );

  let content = '';

  for (const file of audioFiles) {
    content += `file '${file}'\n`;
  }

  fs.writeFileSync(listPath, content);

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      mergedPath,
    ],
    {
      maxBuffer: 1024 * 1024 * 20,
    }
  );

  return mergedPath;
}

async function renderVideo(jobId, payload) {
  const workDir = path.join(
    BASE_DIR,
    `work-${jobId}`
  );

  try {
    updateJob(jobId, {
      status: 'processing',
      error: null,
    });

    fs.mkdirSync(workDir, {
      recursive: true,
    });

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

    const imageFiles = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];

      if (!scene.image_url) {
        throw new Error(
          `Scene ${i + 1} has no image_url`
        );
      }

      const imagePath = path.join(
        workDir,
        `scene_${String(i + 1).padStart(3, '0')}.jpg`
      );

      await downloadFile(
        scene.image_url,
        imagePath
      );

      imageFiles.push(imagePath);
    }

    const audioFiles = [];

    for (let i = 0; i < audioParts.length; i++) {
      const audio = audioParts[i];

      if (!audio.audio_url) {
        throw new Error(
          `Audio part ${i + 1} has no audio_url`
        );
      }

      const audioPath = path.join(
        workDir,
        `audio_${String(i + 1).padStart(3, '0')}.mp3`
      );

      await downloadFile(
        audio.audio_url,
        audioPath
      );

      audioFiles.push(audioPath);
    }

    const finalAudioPath = await mergeAudio(
      audioFiles,
      workDir
    );

    const totalAudioDuration =
      await getAudioDuration(finalAudioPath);

    const sceneDuration =
      totalAudioDuration / imageFiles.length;

    updateJob(jobId, {
      audioDuration: totalAudioDuration,
      sceneDuration,
    });

    const concatPath = path.join(
      workDir,
      'images.txt'
    );

    let concatText = '';

    for (const imageFile of imageFiles) {
      concatText += `file '${imageFile}'\n`;
      concatText += `duration ${sceneDuration}\n`;
    }

    concatText += `file '${
      imageFiles[imageFiles.length - 1]
    }'\n`;

    fs.writeFileSync(
      concatPath,
      concatText
    );

    const outputPath = path.join(
      OUTPUT_DIR,
      `${jobId}.mp4`
    );

    await execFileAsync(
      'ffmpeg',
      [
        '-y',

        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatPath,

        '-i',
        finalAudioPath,

        '-vf',
        [
          'scale=1280:720:force_original_aspect_ratio=decrease',
          'pad=1280:720:(ow-iw)/2:(oh-ih)/2',
          'format=yuv420p',
        ].join(','),

        '-r',
        '24',

        '-c:v',
        'libx264',

        '-preset',
        'ultrafast',

        '-crf',
        '30',

        '-threads',
        '1',

        '-c:a',
        'aac',

        '-b:a',
        '128k',

        '-shortest',

        '-movflags',
        '+faststart',

        outputPath,
      ],
      {
        maxBuffer: 1024 * 1024 * 50,
      }
    );

    updateJob(jobId, {
      status: 'completed',
      outputPath,
      completedAt:
        new Date().toISOString(),
    });

  } catch (error) {
    console.error(
      'Render error:',
      error
    );

    updateJob(jobId, {
      status: 'failed',
      error:
        error.stderr ||
        error.message ||
        String(error),
    });
  } finally {
    try {
      fs.rmSync(workDir, {
        recursive: true,
        force: true,
      });
    } catch (error) {
      console.error(
        'Cleanup error:',
        error
      );
    }
  }
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'n8n-ffmpeg-render',
  });
});

app.post(
  '/render',
  checkApiKey,
  (req, res) => {
    const jobId = crypto.randomUUID();

    saveJob(jobId, {
      jobId,
      status: 'queued',
      error: null,
      audioDuration: null,
      sceneDuration: null,
      createdAt:
        new Date().toISOString(),
    });

    renderVideo(
      jobId,
      req.body
    );

    res.status(202).json({
      job_id: jobId,
      status: 'queued',
      status_url: `/status/${jobId}`,
      download_url:
        `/download/${jobId}`,
    });
  }
);

app.get(
  '/status/:jobId',
  checkApiKey,
  (req, res) => {
    const job = loadJob(
      req.params.jobId
    );

    if (!job) {
      return res.status(404).json({
        error: 'Job not found',
      });
    }

    res.json({
      job_id: req.params.jobId,
      status: job.status,
      error: job.error || null,
      audio_duration:
        job.audioDuration ?? null,
      scene_duration:
        job.sceneDuration ?? null,
    });
  }
);

app.get(
  '/download/:jobId',
  checkApiKey,
  (req, res) => {
    const job = loadJob(
      req.params.jobId
    );

    if (!job) {
      return res.status(404).json({
        error: 'Job not found',
      });
    }

    if (
      job.status !== 'completed'
    ) {
      return res.status(409).json({
        error: 'Video is not ready',
        status: job.status,
      });
    }

    if (
      !job.outputPath ||
      !fs.existsSync(job.outputPath)
    ) {
      return res.status(404).json({
        error: 'Video file not found',
      });
    }

    res.download(
      job.outputPath,
      'final_video.mp4'
    );
  }
);

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `Server running on port ${PORT}`
    );
  }
);
