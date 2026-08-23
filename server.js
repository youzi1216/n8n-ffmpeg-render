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
    limit: '20mb',
  })
);

// ======================================================
// ENVIRONMENT
// ======================================================

const PORT =
  process.env.PORT || 3000;

const API_KEY =
  process.env.API_KEY || '';

const POLLINATIONS_API_KEY =
  process.env.POLLINATIONS_API_KEY || '';


// ======================================================
// DIRECTORIES
// ======================================================

const BASE_DIR =
  '/tmp/n8n-render';

const JOB_DIR =
  path.join(
    BASE_DIR,
    'jobs'
  );

const OUTPUT_DIR =
  path.join(
    BASE_DIR,
    'outputs'
  );

fs.mkdirSync(
  JOB_DIR,
  {
    recursive: true,
  }
);

fs.mkdirSync(
  OUTPUT_DIR,
  {
    recursive: true,
  }
);


// ======================================================
// JOB STORAGE
// ======================================================

function jobFile(jobId) {
  return path.join(
    JOB_DIR,
    `${jobId}.json`
  );
}


function saveJob(
  jobId,
  data
) {
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
  const file =
    jobFile(jobId);

  if (
    !fs.existsSync(file)
  ) {
    return null;
  }

  try {
    return JSON.parse(
      fs.readFileSync(
        file,
        'utf8'
      )
    );
  }

  catch (error) {
    console.error(
      `[${jobId}] Failed to read job:`,
      error
    );

    return null;
  }
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
// AUTH
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
    req.headers[
      'x-api-key'
    ];

  if (
    key !== API_KEY
  ) {
    return res
      .status(401)
      .json({
        error:
          'Unauthorized',
      });
  }

  next();
}


// ======================================================
// SMALL DELAY
// ======================================================

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


// ======================================================
// DOWNLOAD EXISTING FILE
// ======================================================

async function downloadFile(
  url,
  outputPath
) {
  const response =
    await fetch(
      url,
      {
        method:
          'GET',

        redirect:
          'follow',
      }
    );

  if (
    !response.ok
  ) {
    const text =
      await response.text();

    throw new Error(
      `Download failed: ` +
      `${response.status} ` +
      `${response.statusText} ` +
      `${text.slice(0, 300)}`
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
// POLLINATIONS IMAGE GENERATION
// ======================================================

async function generatePollinationsImage(
  prompt,
  outputPath,
  sceneIndex,
  jobId
) {
  if (
    !POLLINATIONS_API_KEY
  ) {
    throw new Error(
      'POLLINATIONS_API_KEY is missing in Render Environment'
    );
  }

  if (
    !prompt ||
    typeof prompt !==
      'string'
  ) {
    throw new Error(
      `Scene ${sceneIndex} has invalid image_prompt`
    );
  }

  // ----------------------------------------------------
  // IMAGE SETTINGS
  // ----------------------------------------------------

  const width = 1536;
  const height = 864;

  const seed =
    10000 +
    Number(sceneIndex);


  // ----------------------------------------------------
  // EXTRA QUALITY / SAFETY PROMPT
  // ----------------------------------------------------

  const enhancedPrompt = `
${prompt}

Single coherent scene.
One continuous composition.
Professional cinematic composition.
High visual fidelity.
Highly detailed subject and environment.
Natural realistic lighting.
Realistic materials and textures.
Sharp subject detail.
Clean depth of field.
Professional YouTube documentary visual style.
16:9 widescreen composition.

Do not create a collage.
Do not create split screen.
Do not create multiple panels.
Do not create subtitles.
Do not create captions.
Do not create logos.
Do not create watermarks.
Do not create readable text.
Do not create random letters.
Do not create gibberish text.
Do not create fake software interfaces.
Do not create distorted user interfaces.
Do not duplicate people.
Do not duplicate objects.
Avoid malformed hands.
Avoid malformed faces.
`.trim();


  const encodedPrompt =
    encodeURIComponent(
      enhancedPrompt
    );


  const url =
    `https://gen.pollinations.ai/image/${encodedPrompt}` +
    `?model=flux` +
    `&width=${width}` +
    `&height=${height}` +
    `&seed=${seed}` +
    `&nologo=true`;


  console.log(
    `[${jobId}] Pollinations request scene ${sceneIndex}`
  );


  const response =
    await fetch(
      url,
      {
        method:
          'GET',

        headers: {
          Authorization:
            `Bearer ${POLLINATIONS_API_KEY}`,
        },

        redirect:
          'follow',
      }
    );


  if (
    !response.ok
  ) {
    const text =
      await response.text();

    throw new Error(
      `Pollinations failed for scene ${sceneIndex}: ` +
      `${response.status} ` +
      `${response.statusText} ` +
      `${text.slice(0, 500)}`
    );
  }


  const contentType =
    response.headers.get(
      'content-type'
    ) || '';


  if (
    !contentType.startsWith(
      'image/'
    )
  ) {
    const text =
      await response.text();

    throw new Error(
      `Pollinations returned non-image content for scene ${sceneIndex}: ` +
      text.slice(
        0,
        500
      )
    );
  }


  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );


  if (
    buffer.length <
    10000
  ) {
    throw new Error(
      `Generated image ${sceneIndex} is unexpectedly small: ${buffer.length} bytes`
    );
  }


  fs.writeFileSync(
    outputPath,
    buffer
  );


  console.log(
    `[${jobId}] image ${sceneIndex} generated ` +
    `(${(
      buffer.length /
      1024
    ).toFixed(1)} KB)`
  );
}


// ======================================================
// RETRY IMAGE GENERATION
// ======================================================

async function generateImageWithRetry(
  prompt,
  outputPath,
  sceneIndex,
  jobId
) {
  const maxAttempts = 3;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    try {
      await generatePollinationsImage(
        prompt,
        outputPath,
        sceneIndex,
        jobId
      );

      return;
    }

    catch (error) {
      console.error(
        `[${jobId}] scene ${sceneIndex} attempt ${attempt}/${maxAttempts} failed:`,
        error.message
      );

      if (
        attempt ===
        maxAttempts
      ) {
        throw error;
      }

      await sleep(
        attempt *
          5000
      );
    }
  }
}


// ======================================================
// AUDIO DURATION
// ======================================================

async function getAudioDuration(
  filePath
) {
  const {
    stdout,
  } =
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
      ],
      {
        maxBuffer:
          1024 *
          1024 *
          10,
      }
    );


  const duration =
    parseFloat(
      stdout.trim()
    );


  if (
    !Number.isFinite(
      duration
    )
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


  const content =
    audioFiles
      .map(
        file =>
          `file '${file.replace(
            /'/g,
            "'\\''"
          )}'`
      )
      .join('\n');


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

      '-vn',

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
        1024 *
        1024 *
        30,
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

    // --------------------------------------------------
    // JOB STATUS
    // --------------------------------------------------

    updateJob(
      jobId,
      {
        status:
          'processing',

        error:
          null,
      }
    );


    fs.mkdirSync(
      workDir,
      {
        recursive:
          true,
      }
    );


    // --------------------------------------------------
    // SCENES
    // --------------------------------------------------

    const scenes =
      Array.isArray(
        payload.scenes
      )
        ? payload.scenes
        : [];


    // --------------------------------------------------
    // AUDIO
    // --------------------------------------------------

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
          part_index:
            1,

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
    // GENERATE / DOWNLOAD IMAGES
    // ==================================================

    const imageFiles = [];


    for (
      let i = 0;
      i <
      scenes.length;
      i++
    ) {
      const scene =
        scenes[i];


      const sceneIndex =
        Number(
          scene.scene_index ??
          i + 1
        );


      const imagePath =
        path.join(
          workDir,

          `scene_${String(
            sceneIndex
          ).padStart(
            3,
            '0'
          )}.jpg`
        );


      // -----------------------------------------------
      // NEW MODE:
      // DIRECT IMAGE GENERATION
      // -----------------------------------------------

      if (
        scene.image_prompt
      ) {
        console.log(
          `[${jobId}] generating image ${i + 1}/${scenes.length}`
        );


        await generateImageWithRetry(
          scene.image_prompt,
          imagePath,
          sceneIndex,
          jobId
        );
      }


      // -----------------------------------------------
      // OLD MODE:
      // SUPPORT EXISTING IMAGE URL
      // -----------------------------------------------

      else if (
        scene.image_url
      ) {
        console.log(
          `[${jobId}] downloading legacy image ${i + 1}/${scenes.length}`
        );


        await downloadFile(
          scene.image_url,
          imagePath
        );
      }


      else {
        throw new Error(
          `Scene ${sceneIndex} has neither image_prompt nor image_url`
        );
      }


      imageFiles.push(
        imagePath
      );


      // Small pause between generations
      // avoids hammering image API
      if (
        i <
        scenes.length -
          1
      ) {
        await sleep(
          1500
        );
      }
    }


    console.log(
      `[${jobId}] all images ready`
    );


    // ==================================================
    // DOWNLOAD AUDIO
    // ==================================================

    const audioFiles = [];


    for (
      let i = 0;
      i <
      audioParts.length;
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


    // ==================================================
    // AUDIO DURATION
    // ==================================================

    console.log(
      `[${jobId}] reading audio duration`
    );


    const totalAudioDuration =
      await getAudioDuration(
        finalAudioPath
      );


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
    // CREATE CONCAT FILE
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


    // Repeat final image
    concatText +=
      `file '${
        imageFiles[
          imageFiles.length -
            1
        ]
      }'\n`;


    fs.writeFileSync(
      concatPath,
      concatText
    );


    // ==================================================
    // OUTPUT
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
      `[${jobId}] output = 1920x1080 / 30fps / CRF20 / veryfast`
    );


    // ==================================================
    // FFMPEG
    // ==================================================

    await execFileAsync(
      'ffmpeg',
      [
        '-y',

        // IMAGE INPUT
        '-f',
        'concat',

        '-safe',
        '0',

        '-i',
        concatPath,


        // AUDIO INPUT
        '-i',
        finalAudioPath,


        // VIDEO FILTER
        '-vf',

        [
          'scale=1920:1080:force_original_aspect_ratio=decrease',

          'pad=1920:1080:(ow-iw)/2:(oh-ih)/2',

          'setsar=1',

          'format=yuv420p',
        ].join(','),


        // FPS
        '-r',
        '30',


        // VIDEO CODEC
        '-c:v',
        'libx264',


        // IMPORTANT:
        // Render Free = 512MB
        // veryfast lowers CPU/RAM load
        '-preset',
        'veryfast',


        // Good visual quality
        '-crf',
        '20',


        '-profile:v',
        'high',


        // AUDIO
        '-c:a',
        'aac',

        '-b:a',
        '192k',

        '-ar',
        '48000',

        '-ac',
        '2',


        // Keep output close to audio duration
        '-shortest',


        // Better web playback
        '-movflags',
        '+faststart',


        outputPath,
      ],
      {
        maxBuffer:
          1024 *
          1024 *
          100,
      }
    );


    console.log(
      `[${jobId}] ffmpeg completed`
    );


    // ==================================================
    // VERIFY VIDEO
    // ==================================================

    if (
      !fs.existsSync(
        outputPath
      )
    ) {
      throw new Error(
        'FFmpeg finished but output file does not exist'
      );
    }


    const outputSize =
      fs.statSync(
        outputPath
      ).size;


    if (
      outputSize <
      100000
    ) {
      throw new Error(
        `Output video is unexpectedly small: ${outputSize} bytes`
      );
    }


    console.log(
      `[${jobId}] output size = ${(
        outputSize /
        1024 /
        1024
      ).toFixed(
        2
      )} MB`
    );


    // ==================================================
    // COMPLETE
    // ==================================================

    updateJob(
      jobId,
      {
        status:
          'completed',

        outputPath,

        outputSize,

        completedAt:
          new Date().toISOString(),
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
          String(
            errorText
          ).slice(
            0,
            20000
          ),
      }
    );
  }


  // ====================================================
  // CLEAN TEMP FILES
  // ====================================================

  finally {

    try {

      fs.rmSync(
        workDir,
        {
          recursive:
            true,

          force:
            true,
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
  (
    req,
    res
  ) => {

    res.json({
      status:
        'ok',

      service:
        'n8n-ffmpeg-render',

      pollinations:
        POLLINATIONS_API_KEY
          ? 'configured'
          : 'missing',

      video_quality:
        '1920x1080',

      fps:
        30,

      preset:
        'veryfast',

      crf:
        20,
    });
  }
);


// ======================================================
// CREATE RENDER JOB
// ======================================================

app.post(
  '/render',

  checkApiKey,

  (
    req,
    res
  ) => {

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


    // Do NOT await:
    // n8n receives job immediately
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
// JOB STATUS
// ======================================================

app.get(
  '/status/:jobId',

  checkApiKey,

  (
    req,
    res
  ) => {

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
        job.error ||
        null,

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
// DOWNLOAD FINAL VIDEO
// ======================================================

app.get(
  '/download/:jobId',

  checkApiKey,

  (
    req,
    res
  ) => {

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
// START
// ======================================================

app.listen(
  PORT,
  '0.0.0.0',

  () => {

    console.log(
      `Server running on port ${PORT}`
    );


    console.log(
      'Video quality: 1920x1080 / 30fps / CRF20 / veryfast'
    );


    console.log(
      `Pollinations API: ${
        POLLINATIONS_API_KEY
          ? 'configured'
          : 'MISSING'
      }`
    );
  }
);
