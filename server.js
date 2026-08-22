const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const app = express();

app.use(
  express.json({
    limit: '10mb',
  })
);

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';

const BASE_DIR = '/tmp/n8n-render';
const JOB_DIR = path.join(BASE_DIR, 'jobs');
const OUTPUT_DIR = path.join(BASE_DIR, 'outputs');

fs.mkdirSync(JOB_DIR, {
  recursive: true,
});

fs.mkdirSync(OUTPUT_DIR, {
  recursive: true,
});


// ======================================================
// JOB STORAGE
// ======================================================

function jobFile(jobId) {
  return path.join(
    JOB_DIR,
    `${jobId}.json`
  );
}


function saveJob(jobId, data) {
  fs.writeFileSync(
    jobFile(jobId),
    JSON.stringify(
      data,
      null,
      2
    )
  );
}


function loadJob(jobId) {
  const file = jobFile(jobId);

  if (!fs.existsSync(file)) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(
      file,
      'utf8'
    )
  );
}


function updateJob(
  jobId,
  changes
) {
  const current =
    loadJob(jobId) || {};

  const updated = {
    ...current,
    ...changes,

    updatedAt:
      new Date().toISOString(),
  };

  saveJob(
    jobId,
    updated
  );

  return updated;
}


// ======================================================
// API KEY
// ======================================================

function checkApiKey(
  req,
  res,
  next
) {
  if (!API_KEY) {
    return next();
  }

  const key =
    req.headers['x-api-key'];

  if (key !== API_KEY) {
    return res
      .status(401)
      .json({
        error: 'Unauthorized',
      });
  }

  next();
}


// ======================================================
// DOWNLOAD FILE
// ======================================================

async function downloadFile(
  url,
  outputPath
) {
  const response =
    await fetch(
      url,
      {
        redirect: 'follow',
      }
    );

  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  fs.writeFileSync(
    outputPath,
    buffer
  );
}


// ======================================================
// AUDIO DURATION
// ======================================================

async function getAudioDuration(
  filePath
) {
  const { stdout } =
    await execFileAsync(
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

  const duration =
    parseFloat(
      stdout.trim()
    );

  if (
    !Number.isFinite(duration)
  ) {
    throw new Error(
      'Unable to detect audio duration'
    );
  }

  return duration;
}


// ======================================================
// MERGE AUDIO
// ======================================================

async function mergeAudio(
  audioFiles,
  workDir,
  jobId
) {
  if (
    audioFiles.length === 1
  ) {
    console.log(
      `[${jobId}] only one audio file, skip merge`
    );

    return audioFiles[0];
  }

  console.log(
    `[${jobId}] merging ${audioFiles.length} audio files`
  );

  const listPath =
    path.join(
      workDir,
      'audio-list.txt'
    );

  const mergedPath =
    path.join(
      workDir,
      'merged-audio.m4a'
    );

  let content = '';

  for (
    const file of audioFiles
  ) {
    content +=
      `file '${file}'\n`;
  }

  fs.writeFileSync(
    listPath,
    content
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
      listPath,

      '-c:a',
      'aac',

      '-b:a',
      '192k',

      '-ar',
      '48000',

      '-ac',
      '2',

      mergedPath,
    ],
    {
      maxBuffer:
        1024 * 1024 * 30,
    }
  );

  console.log(
    `[${jobId}] audio merge completed`
  );

  return mergedPath;
}


// ======================================================
// MAIN VIDEO RENDER
// ======================================================

async function renderVideo(
  jobId,
  payload
) {
  const workDir =
    path.join(
      BASE_DIR,
      `work-${jobId}`
    );

  console.log(
    `[${jobId}] render started`
  );

  try {
    updateJob(
      jobId,
      {
        status: 'processing',
        error: null,
      }
    );

    fs.mkdirSync(
      workDir,
      {
        recursive: true,
      }
    );


    // ==================================================
    // READ SCENES
    // ==================================================

    const scenes =
      Array.isArray(
        payload.scenes
      )
        ? payload.scenes
        : [];


    // ==================================================
    // READ AUDIO
    // ==================================================

    let audioParts = [];

    if (
      Array.isArray(
        payload.audio_parts
      )
    ) {
      audioParts =
        payload.audio_parts;
    }

    else if (
      payload.audio_url
    ) {
      audioParts = [
        {
          part_index: 1,

          audio_url:
            payload.audio_url,
        },
      ];
    }


    console.log(
      `[${jobId}] scenes = ${scenes.length}`
    );

    console.log(
      `[${jobId}] audio parts = ${audioParts.length}`
    );


    if (
      scenes.length === 0
    ) {
      throw new Error(
        'No scenes were provided'
      );
    }


    if (
      audioParts.length === 0
    ) {
      throw new Error(
        'No audio was provided'
      );
    }


    // ==================================================
    // DOWNLOAD IMAGES
    // ==================================================

    const imageFiles = [];

    for (
      let i = 0;
      i < scenes.length;
      i++
    ) {
      const scene =
        scenes[i];

      if (
        !scene.image_url
      ) {
        throw new Error(
          `Scene ${i + 1} has no image_url`
        );
      }

      console.log(
        `[${jobId}] downloading image ${i + 1}/${scenes.length}`
      );

      const imagePath =
        path.join(
          workDir,

          `scene_${String(
            i + 1
          ).padStart(
            3,
            '0'
          )}.jpg`
        );

      await downloadFile(
        scene.image_url,
        imagePath
      );

      imageFiles.push(
        imagePath
      );
    }


    console.log(
      `[${jobId}] all images downloaded`
    );


    // ==================================================
    // DOWNLOAD AUDIO
    // ==================================================

    const audioFiles = [];

    for (
      let i = 0;
      i < audioParts.length;
      i++
    ) {
      const audio =
        audioParts[i];

      if (
        !audio.audio_url
      ) {
        throw new Error(
          `Audio part ${i + 1} has no audio_url`
        );
      }

      console.log(
        `[${jobId}] downloading audio ${i + 1}/${audioParts.length}`
      );

      const audioPath =
        path.join(
          workDir,

          `audio_${String(
            i + 1
          ).padStart(
            3,
            '0'
          )}.mp3`
        );

      await downloadFile(
        audio.audio_url,
        audioPath
      );

      audioFiles.push(
        audioPath
      );
    }


    console.log(
      `[${jobId}] all audio files downloaded`
    );


    // ==================================================
    // PREPARE AUDIO
    // ==================================================

    console.log(
      `[${jobId}] preparing final audio`
    );

    const finalAudioPath =
      await mergeAudio(
        audioFiles,
        workDir,
        jobId
      );


    console.log(
      `[${jobId}] reading audio duration`
    );


    const totalAudioDuration =
      await getAudioDuration(
        finalAudioPath
      );


    // ==================================================
    // AUTOMATIC SCENE DURATION
    // ==================================================

    const sceneDuration =
      totalAudioDuration /
      imageFiles.length;


    console.log(
      `[${jobId}] audio duration = ${totalAudioDuration}`
    );

    console.log(
      `[${jobId}] scene duration = ${sceneDuration}`
    );


    updateJob(
      jobId,
      {
        audioDuration:
          totalAudioDuration,

        sceneDuration:
          sceneDuration,
      }
    );


    // ==================================================
    // CREATE IMAGE CONCAT FILE
    // ==================================================

    const concatPath =
      path.join(
        workDir,
        'images.txt'
      );


    let concatText = '';


    for (
      const imageFile
      of imageFiles
    ) {
      concatText +=
        `file '${imageFile}'\n`;

      concatText +=
        `duration ${sceneDuration}\n`;
    }


    // FFmpeg concat requires last image repeated
    concatText +=
      `file '${
        imageFiles[
          imageFiles.length - 1
        ]
      }'\n`;


    fs.writeFileSync(
      concatPath,
      concatText
    );


    // ==================================================
    // OUTPUT PATH
    // ==================================================

    const outputPath =
      path.join(
        OUTPUT_DIR,
        `${jobId}.mp4`
      );


    console.log(
      `[${jobId}] starting HIGH QUALITY ffmpeg video render`
    );

    console.log(
      `[${jobId}] output = 1920x1080 / 30fps / CRF18`
    );


    // ==================================================
    // HIGH QUALITY FFMPEG
    // ==================================================

    await execFileAsync(
      'ffmpeg',
      [
        '-y',

        // ------------------------------
        // IMAGE INPUT
        // ------------------------------

        '-f',
        'concat',

        '-safe',
        '0',

        '-i',
        concatPath,


        // ------------------------------
        // AUDIO INPUT
        // ------------------------------

        '-i',
        finalAudioPath,


        // ------------------------------
        // VIDEO FILTER
        // ------------------------------

        '-vf',

        [
          // Convert all images to 1080p
          'scale=1920:1080:force_original_aspect_ratio=decrease',

          // Black padding if aspect ratio differs
          'pad=1920:1080:(ow-iw)/2:(oh-ih)/2',

          // Better resizing algorithm
          'setsar=1',

          // Standard YouTube pixel format
          'format=yuv420p',

        ].join(','),


        // ------------------------------
        // FRAME RATE
        // ------------------------------

        '-r',
        '30',


        // ------------------------------
        // VIDEO ENCODER
        // ------------------------------

        '-c:v',
        'libx264',


        // Render Free is CPU limited.
        // fast gives much better quality than ultrafast,
        // while still being more reliable than medium.
        '-preset',
        'fast',


        // CRF:
        // 18 = visually near-lossless for YouTube source
        '-crf',
        '18',


        '-profile:v',
        'high',

        '-level',
        '4.1',


        // ------------------------------
        // AUDIO
        // ------------------------------

        '-c:a',
        'aac',

        '-b:a',
        '192k',

        '-ar',
        '48000',

        '-ac',
        '2',


        // ------------------------------
        // OUTPUT CONTROL
        // ------------------------------

        '-shortest',

        '-movflags',
        '+faststart',

        outputPath,
      ],
      {
        maxBuffer:
          1024 * 1024 * 100,
      }
    );


    console.log(
      `[${jobId}] ffmpeg completed`
    );


    // ==================================================
    // VERIFY OUTPUT
    // ==================================================

    if (
      !fs.existsSync(
        outputPath
      )
    ) {
      throw new Error(
        'FFmpeg completed but output file does not exist'
      );
    }


    const outputSize =
      fs.statSync(
        outputPath
      ).size;


    if (
      outputSize < 100000
    ) {
      throw new Error(
        `Output video is unexpectedly small: ${outputSize} bytes`
      );
    }


    console.log(
      `[${jobId}] output size = ${(outputSize / 1024 / 1024).toFixed(2)} MB`
    );


    // ==================================================
    // COMPLETED
    // ==================================================

    updateJob(
      jobId,
      {
        status:
          'completed',

        outputPath,

        completedAt:
          new Date().toISOString(),

        outputSize,
      }
    );


    console.log(
      `[${jobId}] render completed successfully`
    );
  }


  // ====================================================
  // ERROR
  // ====================================================

  catch (error) {
    const errorText =
      error.stderr ||
      error.message ||
      String(error);


    console.error(
      `[${jobId}] Render error:`,
      errorText
    );


    updateJob(
      jobId,
      {
        status:
          'failed',

        error:
          errorText,
      }
    );
  }


  // ====================================================
  // CLEANUP
  // ====================================================

  finally {
    try {
      fs.rmSync(
        workDir,
        {
          recursive: true,
          force: true,
        }
      );


      console.log(
        `[${jobId}] temp files cleaned`
      );
    }

    catch (error) {
      console.error(
        `[${jobId}] Cleanup error:`,
        error
      );
    }
  }
}


// ======================================================
// HEALTH CHECK
// ======================================================

app.get(
  '/',
  (req, res) => {
    res.json({
      status: 'ok',

      service:
        'n8n-ffmpeg-render',

      video_quality:
        '1080p',

      fps:
        30,

      crf:
        18,
    });
  }
);


// ======================================================
// CREATE RENDER JOB
// ======================================================

app.post(
  '/render',
  checkApiKey,

  (req, res) => {
    const jobId =
      crypto.randomUUID();


    console.log(
      `[${jobId}] new render request received`
    );


    saveJob(
      jobId,
      {
        jobId,

        status:
          'queued',

        error:
          null,

        audioDuration:
          null,

        sceneDuration:
          null,

        outputSize:
          null,

        createdAt:
          new Date().toISOString(),
      }
    );


    // Run rendering asynchronously
    renderVideo(
      jobId,
      req.body
    );


    res
      .status(202)
      .json({
        job_id:
          jobId,

        status:
          'queued',

        status_url:
          `/status/${jobId}`,

        download_url:
          `/download/${jobId}`,
      });
  }
);


// ======================================================
// CHECK JOB STATUS
// ======================================================

app.get(
  '/status/:jobId',
  checkApiKey,

  (req, res) => {
    const job =
      loadJob(
        req.params.jobId
      );


    if (!job) {
      return res
        .status(404)
        .json({
          error:
            'Job not found',
        });
    }


    res.json({
      job_id:
        req.params.jobId,

      status:
        job.status,

      error:
        job.error || null,

      audio_duration:
        job.audioDuration ??
        null,

      scene_duration:
        job.sceneDuration ??
        null,

      output_size:
        job.outputSize ??
        null,
    });
  }
);


// ======================================================
// DOWNLOAD VIDEO
// ======================================================

app.get(
  '/download/:jobId',
  checkApiKey,

  (req, res) => {
    const job =
      loadJob(
        req.params.jobId
      );


    if (!job) {
      return res
        .status(404)
        .json({
          error:
            'Job not found',
        });
    }


    if (
      job.status !==
      'completed'
    ) {
      return res
        .status(409)
        .json({
          error:
            'Video is not ready',

          status:
            job.status,
        });
    }


    if (
      !job.outputPath ||
      !fs.existsSync(
        job.outputPath
      )
    ) {
      return res
        .status(404)
        .json({
          error:
            'Video file not found',
        });
    }


    console.log(
      `[${req.params.jobId}] download requested`
    );


    res.download(
      job.outputPath,
      'final_video.mp4'
    );
  }
);


// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  '0.0.0.0',

  () => {
    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      'Video quality: 1920x1080 / 30fps / CRF20'
    );
  }
);
