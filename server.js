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
    limit: '30mb',
  })
);

// ======================================================
// ENVIRONMENT
// ======================================================

const PORT =
  Number(process.env.PORT || 3000);

const API_KEY =
  process.env.API_KEY || '';

const CLOUDFLARE_ACCOUNT_ID =
  process.env.CLOUDFLARE_ACCOUNT_ID || '';

const CLOUDFLARE_API_TOKEN =
  process.env.CLOUDFLARE_API_TOKEN || '';

const CLOUDFLARE_MODEL =
  process.env.CLOUDFLARE_MODEL ||
  '@cf/black-forest-labs/flux-1-schnell';

// 免費 Render 建議只同時跑 1 個大型 FFmpeg Job
const MAX_CONCURRENT_RENDERS =
  Math.max(
    1,
    Number(
      process.env.MAX_CONCURRENT_RENDERS || 1
    )
  );

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
  } catch (error) {
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
    req.headers['x-api-key'];

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
// BASIC HELPERS
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

function clamp(
  value,
  min,
  max
) {
  return Math.min(
    max,
    Math.max(
      min,
      value
    )
  );
}

function safeNumber(
  value,
  fallback
) {
  const parsed =
    Number(value);

  return Number.isFinite(
    parsed
  )
    ? parsed
    : fallback;
}

// ======================================================
// FILE DOWNLOAD
// ======================================================

async function downloadFile(
  url,
  outputPath,
  jobId = '',
  label = 'file'
) {
  const maxAttempts = 3;

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    try {
      const response =
        await fetch(
          url,
          {
            method:
              'GET',

            redirect:
              'follow',

            headers: {
              'User-Agent':
                'Mozilla/5.0 n8n-render/1.0',
            },
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
          `${text.slice(0, 500)}`
        );
      }

      const buffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      if (
        buffer.length <
        1000
      ) {
        throw new Error(
          `Downloaded ${label} is unexpectedly small: ` +
          `${buffer.length} bytes`
        );
      }

      fs.writeFileSync(
        outputPath,
        buffer
      );

      return;
    } catch (error) {
      lastError =
        error;

      console.error(
        `[${jobId}] ${label} download attempt ` +
        `${attempt}/${maxAttempts} failed:`,
        error.message
      );

      if (
        attempt <
        maxAttempts
      ) {
        await sleep(
          attempt *
          3000
        );
      }
    }
  }

  throw lastError;
}

// ======================================================
// CLOUDFLARE IMAGE GENERATION
// FALLBACK ONLY
// ======================================================

function buildEnhancedPrompt(
  prompt
) {
  const base =
    typeof prompt === 'string'
      ? prompt.trim()
      : '';

  if (!base) {
    return '';
  }

  return `
${base}

Single coherent cinematic scene.
Environmental horror.
Cinematic psychological suspense.
Realistic cinematic photography.
Professional composition.
Highly detailed environment.
Realistic materials and textures.
Natural realistic lighting.
Cold desaturated cinematic color grading.
Deep shadows.
Subtle volumetric light.
Strong environmental storytelling.
Clear focal subject.
Clean depth of field.
16:9 widescreen composition.

No collage.
No split screen.
No multiple panels.
No subtitles.
No captions.
No logo.
No watermark.
No readable text.
No random letters.
No gibberish text.
No people.
No humans.
No human figures.
No silhouettes.
No faces.
No hands.
No bodies.
No ghosts.
No monsters.
No creatures.
No gore.
No blood.
`.trim();
}

async function generateCloudflareImage(
  prompt,
  outputPath,
  sceneIndex,
  jobId
) {
  if (
    !CLOUDFLARE_ACCOUNT_ID
  ) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID is missing'
    );
  }

  if (
    !CLOUDFLARE_API_TOKEN
  ) {
    throw new Error(
      'CLOUDFLARE_API_TOKEN is missing'
    );
  }

  const enhancedPrompt =
    buildEnhancedPrompt(
      prompt
    );

  if (!enhancedPrompt) {
    throw new Error(
      `Scene ${sceneIndex} has invalid image_prompt`
    );
  }

  const finalPrompt =
    enhancedPrompt.slice(
      0,
      2400
    );

  const url =
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${CLOUDFLARE_ACCOUNT_ID}` +
    `/ai/run/` +
    `${CLOUDFLARE_MODEL}`;

  console.log(
    `[${jobId}] Cloudflare fallback request ` +
    `scene ${sceneIndex}`
  );

  const response =
    await fetch(
      url,
      {
        method:
          'POST',

        headers: {
          Authorization:
            `Bearer ${CLOUDFLARE_API_TOKEN}`,

          'Content-Type':
            'application/json',
        },

        body:
          JSON.stringify({
            prompt:
              finalPrompt,

            steps:
              6,
          }),
      }
    );

  const contentType =
    response.headers.get(
      'content-type'
    ) || '';

  if (
    !response.ok
  ) {
    const text =
      await response.text();

    throw new Error(
      `Cloudflare image generation failed for scene ` +
      `${sceneIndex}: ` +
      `${response.status} ` +
      `${response.statusText} ` +
      `${text.slice(0, 1000)}`
    );
  }

  let imageBuffer =
    null;

  if (
    contentType.includes(
      'application/json'
    )
  ) {
    const data =
      await response.json();

    const base64Image =
      data?.result?.image ||
      data?.image ||
      null;

    if (
      !base64Image ||
      typeof base64Image !==
        'string'
    ) {
      throw new Error(
        `Cloudflare returned no image for scene ` +
        `${sceneIndex}: ` +
        JSON.stringify(
          data
        ).slice(
          0,
          1000
        )
      );
    }

    imageBuffer =
      Buffer.from(
        base64Image,
        'base64'
      );
  } else if (
    contentType.startsWith(
      'image/'
    )
  ) {
    imageBuffer =
      Buffer.from(
        await response.arrayBuffer()
      );
  } else {
    const text =
      await response.text();

    throw new Error(
      `Cloudflare returned unexpected content for scene ` +
      `${sceneIndex}: ` +
      text.slice(
        0,
        1000
      )
    );
  }

  if (
    !imageBuffer ||
    imageBuffer.length <
      10000
  ) {
    throw new Error(
      `Generated image ${sceneIndex} is unexpectedly small`
    );
  }

  fs.writeFileSync(
    outputPath,
    imageBuffer
  );

  console.log(
    `[${jobId}] Cloudflare image ${sceneIndex} generated ` +
    `(${(
      imageBuffer.length /
      1024
    ).toFixed(1)} KB)`
  );
}

async function generateImageWithRetry(
  prompt,
  outputPath,
  sceneIndex,
  jobId
) {
  const maxAttempts =
    3;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    try {
      await generateCloudflareImage(
        prompt,
        outputPath,
        sceneIndex,
        jobId
      );

      return;
    } catch (error) {
      console.error(
        `[${jobId}] scene ${sceneIndex} ` +
        `generation attempt ${attempt}/${maxAttempts} failed:`,
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
    ) ||
    duration <= 0
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
// SHOT TYPE / MOTION
// ======================================================

function normalizeShotType(
  value
) {
  return String(
    value || ''
  )
    .trim()
    .toLowerCase()
    .replace(
      /[\s-]+/g,
      '_'
    );
}

function buildMotionExpressions(
  scene,
  index
) {
  const shotType =
    normalizeShotType(
      scene.shot_type
    );

  /*
    保持非常輕微。
    Environmental Horror 不適合快速 Ken Burns。
  */

  if (
    shotType ===
      'close_up' ||
    shotType ===
      'closeup' ||
    shotType ===
      'detail' ||
    shotType ===
      'insert' ||
    shotType ===
      'extreme_close_up'
  ) {
    return {
      zoom:
        "min(zoom+0.00022,1.055)",

      x:
        "iw/2-(iw/zoom/2)",

      y:
        "ih/2-(ih/zoom/2)",
    };
  }

  if (
    shotType ===
      'wide' ||
    shotType ===
      'establishing' ||
    shotType ===
      'environment'
  ) {
    return {
      zoom:
        "min(zoom+0.00013,1.035)",

      x:
        index % 2 === 0
          ? "iw/2-(iw/zoom/2)"
          : "iw/2-(iw/zoom/2)+((iw-iw/zoom)*0.035)",

      y:
        "ih/2-(ih/zoom/2)",
    };
  }

  /*
    其他鏡位交替使用推近 / 拉遠，
    防止整支影片所有圖片都朝同方向動。
  */

  if (
    index % 2 === 0
  ) {
    return {
      zoom:
        "min(zoom+0.00017,1.045)",

      x:
        "iw/2-(iw/zoom/2)",

      y:
        "ih/2-(ih/zoom/2)",
    };
  }

  return {
    zoom:
      "if(eq(on,0),1.045,max(zoom-0.00017,1.001))",

    x:
      "iw/2-(iw/zoom/2)",

    y:
      "ih/2-(ih/zoom/2)",
  };
}

// ======================================================
// TRANSITION
// ======================================================

const ALLOWED_TRANSITIONS =
  new Set([
    'fade',
    'fadeblack',
    'fadewhite',
    'dissolve',
  ]);

function normalizeTransition(
  value
) {
  const candidate =
    String(
      value || 'fade'
    )
      .trim()
      .toLowerCase();

  return ALLOWED_TRANSITIONS.has(
    candidate
  )
    ? candidate
    : 'fade';
}

// ======================================================
// RENDER QUEUE
// ======================================================

const renderQueue =
  [];

let activeRenders =
  0;

function enqueueRender(
  jobId,
  payload
) {
  renderQueue.push({
    jobId,
    payload,
  });

  updateJob(
    jobId,
    {
      status:
        'queued',

      queuePosition:
        renderQueue.length,
    }
  );

  processRenderQueue()
    .catch(error => {
      console.error(
        'Render queue error:',
        error
      );
    });
}

async function processRenderQueue() {
  while (
    activeRenders <
      MAX_CONCURRENT_RENDERS &&
    renderQueue.length >
      0
  ) {
    const {
      jobId,
      payload,
    } =
      renderQueue.shift();

    activeRenders++;

    updateQueuedPositions();

    renderVideo(
      jobId,
      payload
    )
      .catch(error => {
        console.error(
          `[${jobId}] uncaught render error:`,
          error
        );
      })
      .finally(() => {
        activeRenders--;

        processRenderQueue()
          .catch(error => {
            console.error(
              'Render queue continuation error:',
              error
            );
          });
      });
  }
}

function updateQueuedPositions() {
  renderQueue.forEach(
    (
      item,
      index
    ) => {
      updateJob(
        item.jobId,
        {
          queuePosition:
            index + 1,
        }
      );
    }
  );
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
        status:
          'processing',

        queuePosition:
          0,

        progress:
          1,

        currentStep:
          'initializing',

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

    // ==================================================
    // INPUT DATA
    // ==================================================

    let scenes =
      Array.isArray(
        payload.scenes
      )
        ? [...payload.scenes]
        : [];

    let audioParts =
      [];

    if (
      Array.isArray(
        payload.audio_parts
      )
    ) {
      audioParts =
        [...payload.audio_parts];
    } else if (
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
    // SORT SCENES
    // ==================================================

    scenes.sort(
      (
        a,
        b
      ) => {
        const aScene =
          safeNumber(
            a.scene_number,
            0
          );

        const bScene =
          safeNumber(
            b.scene_number,
            0
          );

        if (
          aScene !==
          bScene
        ) {
          return (
            aScene -
            bScene
          );
        }

        return (
          safeNumber(
            a.shot_index,
            1
          ) -
          safeNumber(
            b.shot_index,
            1
          )
        );
      }
    );

    audioParts.sort(
      (
        a,
        b
      ) =>
        safeNumber(
          a.part_index,
          0
        ) -
        safeNumber(
          b.part_index,
          0
        )
    );

    console.log(
      `[${jobId}] visuals = ${scenes.length}`
    );

    console.log(
      `[${jobId}] audio parts = ${audioParts.length}`
    );

    // ==================================================
    // RENDER SETTINGS
    // ==================================================

    const settings =
      payload.render_settings &&
      typeof payload.render_settings ===
        'object'
        ? payload.render_settings
        : {};

    const width =
      Math.max(
        640,
        Math.round(
          safeNumber(
            settings.width,
            1920
          )
        )
      );

    const height =
      Math.max(
        360,
        Math.round(
          safeNumber(
            settings.height,
            1080
          )
        )
      );

    const fps =
      clamp(
        Math.round(
          safeNumber(
            settings.fps,
            30
          )
        ),
        24,
        60
      );

    const transitionDuration =
      clamp(
        safeNumber(
          settings.transition_duration,
          0.7
        ),
        0.2,
        1.5
      );

    const transitionType =
      normalizeTransition(
        settings.transition_type
      );

    const crf =
      clamp(
        Math.round(
          safeNumber(
            settings.crf,
            20
          )
        ),
        16,
        28
      );

    const preset =
      String(
        settings.preset ||
        'veryfast'
      );

    const threads =
      Math.max(
        1,
        Math.round(
          safeNumber(
            settings.threads,
            1
          )
        )
      );

    // ==================================================
    // PREPARE IMAGES
    // ==================================================

    updateJob(
      jobId,
      {
        progress:
          5,

        currentStep:
          'preparing_images',

        totalVisuals:
          scenes.length,
      }
    );

    const imageFiles =
      [];

    for (
      let i = 0;
      i <
      scenes.length;
      i++
    ) {
      const scene =
        scenes[i] || {};

      const renderIndex =
        safeNumber(
          scene.render_index,
          safeNumber(
            scene.scene_number,
            i + 1
          )
        );

      const sceneNumber =
        safeNumber(
          scene.original_scene_number,
          safeNumber(
            scene.scene_number,
            i + 1
          )
        );

      const shotIndex =
        safeNumber(
          scene.shot_index,
          1
        );

      const imagePath =
        path.join(
          workDir,
          `visual_${String(
            i + 1
          ).padStart(
            3,
            '0'
          )}.png`
        );

      /*
        新版優先 image_url。

        這表示：
        n8n 已生成圖片
        → 上傳 Drive
        → Render 只下載
        → 不再浪費 Cloudflare 額度。
      */

      if (
        typeof scene.image_url ===
          'string' &&
        scene.image_url.trim()
      ) {
        console.log(
          `[${jobId}] downloading visual ` +
          `${i + 1}/${scenes.length} ` +
          `(scene ${sceneNumber}, shot ${shotIndex})`
        );

        await downloadFile(
          scene.image_url.trim(),
          imagePath,
          jobId,
          `visual ${i + 1}`
        );
      }

      /*
        舊流程相容：
        如果真的沒有 image_url，
        才使用 Cloudflare image_prompt。
      */

      else if (
        typeof scene.image_prompt ===
          'string' &&
        scene.image_prompt.trim()
      ) {
        console.log(
          `[${jobId}] no image_url; using Cloudflare fallback ` +
          `visual ${i + 1}/${scenes.length}`
        );

        await generateImageWithRetry(
          scene.image_prompt,
          imagePath,
          renderIndex,
          jobId
        );
      } else {
        throw new Error(
          `Visual ${i + 1} has neither image_url nor image_prompt`
        );
      }

      imageFiles.push(
        imagePath
      );

      const imageProgress =
        5 +
        Math.round(
          (
            (i + 1) /
            scenes.length
          ) *
          25
        );

      updateJob(
        jobId,
        {
          progress:
            imageProgress,

          currentStep:
            `images_${i + 1}_of_${scenes.length}`,
        }
      );

      /*
        如果只是 Drive download，
        不需要每張硬等 1 秒。
      */

      if (
        i <
        scenes.length -
          1
      ) {
        await sleep(
          150
        );
      }
    }

    console.log(
      `[${jobId}] all visuals ready`
    );

    // ==================================================
    // DOWNLOAD AUDIO
    // ==================================================

    updateJob(
      jobId,
      {
        progress:
          32,

        currentStep:
          'downloading_audio',
      }
    );

    const audioFiles =
      [];

    for (
      let i = 0;
      i <
      audioParts.length;
      i++
    ) {
      const audio =
        audioParts[i];

      if (
        !audio ||
        typeof audio.audio_url !==
          'string' ||
        !audio.audio_url.trim()
      ) {
        throw new Error(
          `Audio part ${i + 1} has no audio_url`
        );
      }

      console.log(
        `[${jobId}] downloading audio ` +
        `${i + 1}/${audioParts.length}`
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
        audio.audio_url.trim(),
        audioPath,
        jobId,
        `audio ${i + 1}`
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

    updateJob(
      jobId,
      {
        progress:
          38,

        currentStep:
          'merging_audio',
      }
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

    const totalAudioDuration =
      await getAudioDuration(
        finalAudioPath
      );

    console.log(
      `[${jobId}] audio duration = ` +
      `${totalAudioDuration.toFixed(3)}`
    );

    const imageCount =
      imageFiles.length;

    /*
      XFADE 時間計算：

      最終長度 =
        N * clipDuration
        - (N - 1) * transitionDuration

      因此：

      clipDuration =
        (
          audioDuration +
          (N - 1) * transition
        ) / N

      這樣最後畫面總長會與旁白一致。
    */

    const clipDuration =
      (
        totalAudioDuration +
        (
          imageCount -
          1
        ) *
        transitionDuration
      ) /
      imageCount;

    const visibleStepDuration =
      clipDuration -
      transitionDuration;

    if (
      clipDuration <=
      transitionDuration
    ) {
      throw new Error(
        `Calculated clip duration (${clipDuration}) ` +
        `is too short for transition (${transitionDuration})`
      );
    }

    console.log(
      `[${jobId}] visual count = ${imageCount}`
    );

    console.log(
      `[${jobId}] clip duration = ` +
      `${clipDuration.toFixed(3)}`
    );

    console.log(
      `[${jobId}] transition = ` +
      `${transitionDuration.toFixed(3)}`
    );

    console.log(
      `[${jobId}] visible step = ` +
      `${visibleStepDuration.toFixed(3)}`
    );

    updateJob(
      jobId,
      {
        audioDuration:
          totalAudioDuration,

        sceneDuration:
          visibleStepDuration,

        clipDuration:
          clipDuration,

        transitionDuration:
          transitionDuration,

        progress:
          42,

        currentStep:
          'building_video',
      }
    );

    // ==================================================
    // BUILD FFMPEG INPUTS
    // ==================================================

    const ffmpegArgs = [
      '-y',
    ];

    for (
      const imageFile
      of imageFiles
    ) {
      ffmpegArgs.push(
        '-loop',
        '1',

        '-framerate',
        String(fps),

        '-t',
        clipDuration.toFixed(6),

        '-i',
        imageFile
      );
    }

    /*
      最後一個 input 為完整 audio。
      index = imageCount
    */

    ffmpegArgs.push(
      '-i',
      finalAudioPath
    );

    // ==================================================
    // BUILD VISUAL FILTERS
    // ==================================================

    const filters =
      [];

    for (
      let i = 0;
      i <
      imageCount;
      i++
    ) {
      const scene =
        scenes[i] || {};

      const motion =
        buildMotionExpressions(
          scene,
          i
        );

      /*
        scale 先略大於輸出，
        zoompan 才有像攝影機推進的空間。

        force_original_aspect_ratio=increase
        + crop
        可以避免上下黑邊。
      */

      filters.push(
        `[${i}:v]` +

        `scale=` +
        `${Math.round(
          width * 1.08
        )}:` +
        `${Math.round(
          height * 1.08
        )}:` +
        `force_original_aspect_ratio=increase,` +

        `crop=` +
        `${Math.round(
          width * 1.08
        )}:` +
        `${Math.round(
          height * 1.08
        )},` +

        `zoompan=` +
        `z='${motion.zoom}':` +
        `x='${motion.x}':` +
        `y='${motion.y}':` +
        `d=1:` +
        `s=${width}x${height}:` +
        `fps=${fps},` +

        `fps=${fps},` +
        `settb=AVTB,` +
        `setpts=PTS-STARTPTS,` +
        `setsar=1,` +
        `format=yuv420p` +

        `[v${i}]`
      );
    }

    // ==================================================
    // XFADE CHAIN
    // ==================================================

    let previousLabel =
      'v0';

    if (
      imageCount >
      1
    ) {
      for (
        let i = 1;
        i <
        imageCount;
        i++
      ) {
        const outputLabel =
          `xf${i}`;

        /*
          每次下一個 clip 在：

          i * visibleStepDuration

          開始淡入。
        */

        const offset =
          visibleStepDuration *
          i;

        filters.push(
          `[${previousLabel}]` +
          `[v${i}]` +

          `xfade=` +
          `transition=${transitionType}:` +
          `duration=${transitionDuration.toFixed(6)}:` +
          `offset=${offset.toFixed(6)}` +

          `[${outputLabel}]`
        );

        previousLabel =
          outputLabel;
      }
    }

    const filterComplex =
      filters.join(
        ';'
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
      `[${jobId}] starting FFmpeg cinematic render`
    );

    console.log(
      `[${jobId}] ` +
      `${width}x${height} / ` +
      `${fps}fps / ` +
      `CRF${crf} / ` +
      `${preset} / ` +
      `${imageCount} visuals / ` +
      `${transitionDuration}s crossfade`
    );

    ffmpegArgs.push(
      '-filter_complex',
      filterComplex,

      '-map',
      `[${previousLabel}]`,

      '-map',
      `${imageCount}:a:0`,

      '-c:v',
      'libx264',

      '-preset',
      preset,

      '-crf',
      String(crf),

      '-threads',
      String(threads),

      '-profile:v',
      'high',

      '-pix_fmt',
      'yuv420p',

      '-c:a',
      'aac',

      '-b:a',
      '192k',

      '-ar',
      '48000',

      '-ac',
      '2',

      '-r',
      String(fps),

      /*
        精準以旁白長度結束。
      */

      '-t',
      totalAudioDuration.toFixed(
        6
      ),

      '-movflags',
      '+faststart',

      outputPath
    );

    updateJob(
      jobId,
      {
        progress:
          48,

        currentStep:
          'ffmpeg_rendering',
      }
    );

    await execFileAsync(
      'ffmpeg',
      ffmpegArgs,
      {
        maxBuffer:
          1024 *
          1024 *
          200,
      }
    );

    console.log(
      `[${jobId}] FFmpeg completed`
    );

    // ==================================================
    // VALIDATE OUTPUT
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
        `Output video is unexpectedly small: ` +
        `${outputSize} bytes`
      );
    }

    const finalDuration =
      await getAudioDuration(
        outputPath
      );

    console.log(
      `[${jobId}] output size = ` +
      `${(
        outputSize /
        1024 /
        1024
      ).toFixed(2)} MB`
    );

    console.log(
      `[${jobId}] output duration = ` +
      `${finalDuration.toFixed(2)} sec`
    );

    updateJob(
      jobId,
      {
        status:
          'completed',

        outputPath,

        outputSize,

        outputDuration:
          finalDuration,

        progress:
          100,

        currentStep:
          'completed',

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

        progress:
          null,

        currentStep:
          'failed',

        error:
          String(
            errorText
          ).slice(
            0,
            30000
          ),
      }
    );
  }

  // ====================================================
  // CLEANUP TEMP FILES
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
    } catch (error) {
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

      mode:
        'cinematic-environmental-horror',

      image_provider:
        'n8n-image-url-first-cloudflare-fallback',

      cloudflare_account:
        CLOUDFLARE_ACCOUNT_ID
          ? 'configured'
          : 'missing',

      cloudflare_token:
        CLOUDFLARE_API_TOKEN
          ? 'configured'
          : 'missing',

      model:
        CLOUDFLARE_MODEL,

      video_quality:
        '1920x1080',

      fps:
        30,

      preset:
        'veryfast',

      crf:
        20,

      max_concurrent_renders:
        MAX_CONCURRENT_RENDERS,

      active_renders:
        activeRenders,

      queued_renders:
        renderQueue.length,

      features: [
        'image-url-first',
        'cloudflare-fallback',
        'multi-shot-support',
        'shot-type-motion',
        'ken-burns',
        'crossfade',
        'audio-sync',
        'render-queue',
      ],
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
    const payload =
      req.body || {};

    if (
      !Array.isArray(
        payload.scenes
      ) ||
      payload.scenes.length ===
        0
    ) {
      return res
        .status(400)
        .json({
          error:
            'scenes array is required',
        });
    }

    if (
      !(
        Array.isArray(
          payload.audio_parts
        ) &&
        payload.audio_parts.length >
          0
      ) &&
      !payload.audio_url
    ) {
      return res
        .status(400)
        .json({
          error:
            'audio_parts or audio_url is required',
        });
    }

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

        queuePosition:
          renderQueue.length +
          1,

        progress:
          0,

        currentStep:
          'queued',

        error:
          null,

        totalVisuals:
          payload.scenes.length,

        audioDuration:
          null,

        sceneDuration:
          null,

        clipDuration:
          null,

        transitionDuration:
          null,

        outputSize:
          null,

        outputDuration:
          null,

        createdAt:
          new Date().toISOString(),
      }
    );

    enqueueRender(
      jobId,
      payload
    );

    res
      .status(202)
      .json({
        job_id:
          jobId,

        status:
          'queued',

        queue_position:
          renderQueue.length,

        status_url:
          `/status/${jobId}`,

        download_url:
          `/download/${jobId}`,
      });
  }
);

// ======================================================
// STATUS
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

      queue_position:
        job.queuePosition ??
        0,

      progress:
        job.progress ??
        null,

      current_step:
        job.currentStep ??
        null,

      error:
        job.error ||
        null,

      total_visuals:
        job.totalVisuals ??
        null,

      audio_duration:
        job.audioDuration ??
        null,

      scene_duration:
        job.sceneDuration ??
        null,

      clip_duration:
        job.clipDuration ??
        null,

      transition_duration:
        job.transitionDuration ??
        null,

      output_duration:
        job.outputDuration ??
        null,

      output_size:
        job.outputSize ??
        null,
    });
  }
);

// ======================================================
// DOWNLOAD
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

          progress:
            job.progress ??
            null,

          current_step:
            job.currentStep ??
            null,
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
      'Render mode: Cinematic Environmental Horror'
    );

    console.log(
      'Image priority: image_url -> Cloudflare fallback'
    );

    console.log(
      `Cloudflare Account: ${
        CLOUDFLARE_ACCOUNT_ID
          ? 'configured'
          : 'MISSING'
      }`
    );

    console.log(
      `Cloudflare API Token: ${
        CLOUDFLARE_API_TOKEN
          ? 'configured'
          : 'MISSING'
      }`
    );

    console.log(
      `Model: ${CLOUDFLARE_MODEL}`
    );

    console.log(
      'Video: 1920x1080 / 30fps / CRF20 / veryfast'
    );

    console.log(
      'Motion: shot-aware Ken Burns + crossfade'
    );

    console.log(
      `Max concurrent renders: ${MAX_CONCURRENT_RENDERS}`
    );
  }
);
