const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();

app.use(
  express.json({
    limit: '30mb',
  })
);


// ============================================================
// ENV
// ============================================================

const PORT =
  Number(process.env.PORT || 3000);

const API_KEY =
  String(
    process.env.API_KEY || ''
  ).trim();

const CLOUDFLARE_ACCOUNT_ID =
  String(
    process.env.CLOUDFLARE_ACCOUNT_ID || ''
  ).trim();

const CLOUDFLARE_API_TOKEN =
  String(
    process.env.CLOUDFLARE_API_TOKEN || ''
  ).trim();

const CLOUDFLARE_MODEL =
  String(
    process.env.CLOUDFLARE_MODEL ||
    '@cf/black-forest-labs/flux-1-schnell'
  ).trim();


// ============================================================
// PERFORMANCE SETTINGS
// ============================================================

// 免費 Render 建議一次只做一支
const MAX_CONCURRENT_RENDERS =
  Math.max(
    1,
    Number(
      process.env.MAX_CONCURRENT_RENDERS || 1
    )
  );

// FFmpeg 真正開始後的硬限制
const MAX_RENDER_MINUTES =
  Math.max(
    5,
    Number(
      process.env.MAX_RENDER_MINUTES || 25
    )
  );

const MAX_RENDER_MS =
  MAX_RENDER_MINUTES *
  60 *
  1000;


// ============================================================
// DEFAULT VIDEO SETTINGS
// ============================================================

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 24;

const DEFAULT_TRANSITION_DURATION = 0.5;
const DEFAULT_TRANSITION_TYPE = 'fade';

const DEFAULT_CRF = 23;
const DEFAULT_PRESET = 'ultrafast';

// 免費 Render 通常不要開太多 thread
const DEFAULT_THREADS = 2;


// ============================================================
// DIRECTORIES
// ============================================================

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


// ============================================================
// JOB STORAGE
// ============================================================

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
      `[${jobId}] loadJob failed:`,
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


// ============================================================
// AUTH
// ============================================================

function checkApiKey(
  req,
  res,
  next
) {

  if (!API_KEY) {
    return next();
  }

  const provided =
    String(
      req.headers['x-api-key'] || ''
    );

  if (
    provided !== API_KEY
  ) {

    return res
      .status(401)
      .json({
        error: 'Unauthorized',
      });
  }

  next();
}


// ============================================================
// HELPERS
// ============================================================

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

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}


function safeString(
  value,
  fallback = ''
) {

  if (
    value === null ||
    value === undefined
  ) {
    return fallback;
  }

  return String(value);
}


function normalizeShotType(value) {

  return safeString(value)
    .trim()
    .toLowerCase()
    .replace(
      /[\s-]+/g,
      '_'
    );
}


// ============================================================
// PROCESS RUNNER
// ============================================================

function runProcess(
  command,
  args,
  options = {}
) {

  const {
    timeoutMs = 0,
    jobId = '',
    label = command,
  } = options;


  return new Promise(
    (
      resolve,
      reject
    ) => {

      console.log(
        `[${jobId}] starting ${label}`
      );


      const child =
        spawn(
          command,
          args,
          {
            stdio: [
              'ignore',
              'pipe',
              'pipe',
            ],
          }
        );


      let stdout = '';
      let stderr = '';

      let timeoutTriggered =
        false;

      let timeoutHandle =
        null;


      child.stdout.on(
        'data',
        chunk => {

          stdout +=
            chunk.toString();

          if (
            stdout.length >
            2_000_000
          ) {
            stdout =
              stdout.slice(
                -1_000_000
              );
          }
        }
      );


      child.stderr.on(
        'data',
        chunk => {

          stderr +=
            chunk.toString();

          if (
            stderr.length >
            5_000_000
          ) {
            stderr =
              stderr.slice(
                -2_000_000
              );
          }
        }
      );


      if (
        timeoutMs >
        0
      ) {

        timeoutHandle =
          setTimeout(
            () => {

              timeoutTriggered =
                true;

              console.error(
                `[${jobId}] ${label} timeout`
              );

              try {
                child.kill(
                  'SIGTERM'
                );
              } catch (_) {
                // ignore
              }


              setTimeout(
                () => {

                  try {

                    child.kill(
                      'SIGKILL'
                    );

                  } catch (_) {
                    // ignore
                  }

                },
                5000
              );

            },
            timeoutMs
          );
      }


      child.on(
        'error',
        error => {

          if (
            timeoutHandle
          ) {
            clearTimeout(
              timeoutHandle
            );
          }

          reject(error);
        }
      );


      child.on(
        'close',
        code => {

          if (
            timeoutHandle
          ) {
            clearTimeout(
              timeoutHandle
            );
          }


          if (
            timeoutTriggered
          ) {

            return reject(
              new Error(
                `${label} exceeded maximum runtime of ` +
                `${MAX_RENDER_MINUTES} minutes`
              )
            );
          }


          if (
            code !== 0
          ) {

            return reject(
              new Error(
                `${label} exited with code ${code}\n` +
                stderr.slice(
                  -12000
                )
              )
            );
          }


          return resolve({
            stdout,
            stderr,
          });

        }
      );

    }
  );
}


// ============================================================
// DOWNLOAD FILE
// ============================================================

async function downloadFile(
  url,
  outputPath,
  jobId = '',
  label = 'file'
) {

  const maxAttempts =
    4;

  let lastError =
    null;


  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {

    try {

      console.log(
        `[${jobId}] download ${label} ` +
        `${attempt}/${maxAttempts}`
      );


      const response =
        await fetch(
          url,
          {
            method: 'GET',

            redirect:
              'follow',

            headers: {
              'User-Agent':
                'Mozilla/5.0 n8n-render-fast/3.0',
            },
          }
        );


      if (
        !response.ok
      ) {

        const responseText =
          await response.text();

        throw new Error(
          `HTTP ${response.status}: ` +
          responseText.slice(
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
        500
      ) {
        throw new Error(
          `${label} returned only ${buffer.length} bytes`
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
        `[${jobId}] ${label} download failed:`,
        error.message
      );


      if (
        attempt <
        maxAttempts
      ) {

        await sleep(
          attempt *
          2500
        );
      }

    }
  }


  throw lastError;
}


// ============================================================
// CLOUDFLARE FALLBACK
// ============================================================

function buildEnhancedPrompt(prompt) {

  const base =
    safeString(
      prompt
    ).trim();


  if (!base) {
    return '';
  }


  return `
${base}

cinematic psychological horror,
environmental horror,
eerie liminal space,
empty environment,
realistic cinematic photography,
professional cinematic composition,
realistic architecture,
realistic materials,
subtle unsettling environmental details,
cold desaturated color grading,
deep shadows,
soft volumetric lighting,
low saturation,
atmospheric suspense,
highly detailed,
16:9 widescreen,
no people,
no humans,
no person,
no man,
no woman,
no children,
no human figures,
no silhouettes,
no human shadows,
no faces,
no hands,
no bodies,
no ghosts,
no monsters,
no creatures,
no humanoid figures,
no readable text,
no subtitles,
no captions,
no logo,
no watermark,
no split screen,
no collage,
no cartoon,
no anime,
no gore,
no blood
`.trim();
}


async function generateCloudflareImage(
  prompt,
  outputPath,
  visualIndex,
  jobId
) {

  if (
    !CLOUDFLARE_ACCOUNT_ID
  ) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID missing'
    );
  }


  if (
    !CLOUDFLARE_API_TOKEN
  ) {
    throw new Error(
      'CLOUDFLARE_API_TOKEN missing'
    );
  }


  const finalPrompt =
    buildEnhancedPrompt(
      prompt
    );


  if (!finalPrompt) {

    throw new Error(
      `Visual ${visualIndex} image_prompt empty`
    );
  }


  const url =
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${CLOUDFLARE_ACCOUNT_ID}` +
    `/ai/run/${CLOUDFLARE_MODEL}`;


  const response =
    await fetch(
      url,
      {
        method: 'POST',

        headers: {
          Authorization:
            `Bearer ${CLOUDFLARE_API_TOKEN}`,

          'Content-Type':
            'application/json',
        },

        body:
          JSON.stringify({
            prompt:
              finalPrompt.slice(
                0,
                2400
              ),

            steps: 6,
          }),
      }
    );


  if (
    !response.ok
  ) {

    const text =
      await response.text();

    throw new Error(
      `Cloudflare ${response.status}: ` +
      text.slice(
        0,
        1000
      )
    );
  }


  const contentType =
    response.headers.get(
      'content-type'
    ) || '';


  let buffer =
    null;


  if (
    contentType.includes(
      'application/json'
    )
  ) {

    const json =
      await response.json();

    const image =
      json?.result?.image ||
      json?.image;


    if (
      !image ||
      typeof image !==
      'string'
    ) {

      throw new Error(
        'Cloudflare returned no image'
      );
    }


    buffer =
      Buffer.from(
        image,
        'base64'
      );

  } else if (
    contentType.startsWith(
      'image/'
    )
  ) {

    buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

  } else {

    const text =
      await response.text();

    throw new Error(
      `Unexpected Cloudflare response: ` +
      text.slice(
        0,
        500
      )
    );
  }


  if (
    !buffer ||
    buffer.length <
    10000
  ) {

    throw new Error(
      `Visual ${visualIndex} generated invalid image`
    );
  }


  fs.writeFileSync(
    outputPath,
    buffer
  );
}


async function generateImageWithRetry(
  prompt,
  outputPath,
  visualIndex,
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
        visualIndex,
        jobId
      );

      return;

    } catch (error) {

      console.error(
        `[${jobId}] Cloudflare visual ${visualIndex} ` +
        `attempt ${attempt}: ${error.message}`
      );


      if (
        attempt ===
        maxAttempts
      ) {
        throw error;
      }


      await sleep(
        attempt *
        4000
      );

    }
  }
}


// ============================================================
// MEDIA DURATION
// ============================================================

async function getMediaDuration(
  filePath,
  jobId = ''
) {

  const result =
    await runProcess(
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
        timeoutMs:
          60_000,

        jobId,

        label:
          'ffprobe',
      }
    );


  const duration =
    parseFloat(
      result.stdout.trim()
    );


  if (
    !Number.isFinite(
      duration
    ) ||
    duration <= 0
  ) {

    throw new Error(
      `Invalid media duration for ${filePath}`
    );
  }


  return duration;
}


// ============================================================
// MERGE AUDIO
// ============================================================

async function mergeAudio(
  audioFiles,
  workDir,
  jobId
) {

  if (
    audioFiles.length === 1
  ) {

    return audioFiles[0];
  }


  const listPath =
    path.join(
      workDir,
      'audio-list.txt'
    );


  const outputPath =
    path.join(
      workDir,
      'merged-audio.m4a'
    );


  const listContent =
    audioFiles
      .map(
        file => {

          const safe =
            file.replace(
              /'/g,
              "'\\''"
            );

          return (
            `file '${safe}'`
          );
        }
      )
      .join('\n');


  fs.writeFileSync(
    listPath,
    listContent
  );


  await runProcess(
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
      '160k',

      '-ar',
      '44100',

      '-ac',
      '2',

      outputPath,
    ],
    {
      timeoutMs:
        5 *
        60 *
        1000,

      jobId,

      label:
        'audio merge',
    }
  );


  return outputPath;
}


// ============================================================
// TRANSITIONS
// ============================================================

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

  const transition =
    safeString(
      value,
      DEFAULT_TRANSITION_TYPE
    )
      .trim()
      .toLowerCase();


  return ALLOWED_TRANSITIONS.has(
    transition
  )
    ? transition
    : DEFAULT_TRANSITION_TYPE;
}


// ============================================================
// MOTION STRATEGY
// ============================================================

function shouldUseMotion(
  scene,
  index
) {

  const shotType =
    normalizeShotType(
      scene.shot_type
    );


  // 環境建立鏡頭才做真正 Ken Burns
  if (
    [
      'establishing',
      'wide',
      'environment',
    ].includes(
      shotType
    )
  ) {
    return true;
  }


  // 特寫刻意保持穩定
  if (
    [
      'detail',
      'close_up',
      'closeup',
      'insert',
      'extreme_close_up',
    ].includes(
      shotType
    )
  ) {
    return false;
  }


  // 未知 shot_type 每兩張才動一張
  return (
    index %
    2 ===
    0
  );
}


function buildZoomExpression(
  index
) {

  if (
    index %
    2 ===
    0
  ) {

    return {
      zoom:
        'min(zoom+0.00013,1.030)',

      x:
        'iw/2-(iw/zoom/2)',

      y:
        'ih/2-(ih/zoom/2)',
    };
  }


  return {
    zoom:
      'min(zoom+0.00011,1.028)',

    x:
      'iw/2-(iw/zoom/2)+((iw-iw/zoom)*0.02)',

    y:
      'ih/2-(ih/zoom/2)',
  };
}


// ============================================================
// QUEUE
// ============================================================

const renderQueue = [];

let activeRenders = 0;


function updateQueuePositions() {

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
      status: 'queued',

      queuePosition:
        renderQueue.length,

      progress: 0,

      currentStep:
        'queued',
    }
  );


  processQueue()
    .catch(
      error => {

        console.error(
          'Queue error:',
          error
        );

      }
    );
}


async function processQueue() {

  while (
    activeRenders <
      MAX_CONCURRENT_RENDERS &&
    renderQueue.length >
      0
  ) {

    const next =
      renderQueue.shift();


    activeRenders++;


    updateQueuePositions();


    renderVideo(
      next.jobId,
      next.payload
    )
      .catch(
        error => {

          console.error(
            `[${next.jobId}] render error:`,
            error
          );

        }
      )
      .finally(
        () => {

          activeRenders--;

          processQueue()
            .catch(
              error => {

                console.error(
                  'Queue continuation error:',
                  error
                );

              }
            );
        }
      );

  }
}


// ============================================================
// MAIN RENDER
// ============================================================

async function renderVideo(
  jobId,
  payload
) {

  const workDir =
    path.join(
      BASE_DIR,
      `work-${jobId}`
    );


  try {

    fs.mkdirSync(
      workDir,
      {
        recursive: true,
      }
    );


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

        timeoutReached:
          false,

        renderStartedAt:
          new Date().toISOString(),
      }
    );


    // ========================================================
    // INPUT
    // ========================================================

    let scenes =
      Array.isArray(
        payload.scenes
      )
        ? [...payload.scenes]
        : [];


    let audioParts =
      Array.isArray(
        payload.audio_parts
      )
        ? [...payload.audio_parts]
        : [];


    if (
      audioParts.length === 0 &&
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


    if (
      scenes.length ===
      0
    ) {

      throw new Error(
        'No scenes provided'
      );
    }


    if (
      audioParts.length ===
      0
    ) {

      throw new Error(
        'No audio provided'
      );
    }


    // ========================================================
    // SORT VISUALS
    // ========================================================

    scenes.sort(
      (
        a,
        b
      ) => {

        const aRenderIndex =
          safeNumber(
            a.render_index,
            safeNumber(
              a.scene_number,
              0
            )
          );


        const bRenderIndex =
          safeNumber(
            b.render_index,
            safeNumber(
              b.scene_number,
              0
            )
          );


        if (
          aRenderIndex !==
          bRenderIndex
        ) {

          return (
            aRenderIndex -
            bRenderIndex
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


    // ========================================================
    // SETTINGS
    // ========================================================

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
            DEFAULT_WIDTH
          )
        )
      );


    const height =
      Math.max(
        360,
        Math.round(
          safeNumber(
            settings.height,
            DEFAULT_HEIGHT
          )
        )
      );


    const fps =
      clamp(
        Math.round(
          safeNumber(
            settings.fps,
            DEFAULT_FPS
          )
        ),
        20,
        30
      );


    const transitionDuration =
      clamp(
        safeNumber(
          settings.transition_duration,
          DEFAULT_TRANSITION_DURATION
        ),
        0.2,
        1.0
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
            DEFAULT_CRF
          )
        ),
        18,
        28
      );


    const preset =
      safeString(
        settings.preset,
        DEFAULT_PRESET
      );


    const threads =
      Math.max(
        1,
        Math.round(
          safeNumber(
            settings.threads,
            DEFAULT_THREADS
          )
        )
      );


    console.log(
      `[${jobId}] SETTINGS`
    );

    console.log(
      `[${jobId}] ${width}x${height}`
    );

    console.log(
      `[${jobId}] fps=${fps}`
    );

    console.log(
      `[${jobId}] visuals=${scenes.length}`
    );

    console.log(
      `[${jobId}] preset=${preset}`
    );

    console.log(
      `[${jobId}] crf=${crf}`
    );


    // ========================================================
    // IMAGES
    // ========================================================

    updateJob(
      jobId,
      {
        progress: 5,

        currentStep:
          'preparing_images',

        totalVisuals:
          scenes.length,
      }
    );


    const imageFiles = [];


    for (
      let i = 0;
      i < scenes.length;
      i++
    ) {

      const scene =
        scenes[i] || {};


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


      if (
        typeof scene.image_url ===
          'string' &&
        scene.image_url.trim()
      ) {

        await downloadFile(
          scene.image_url.trim(),
          imagePath,
          jobId,
          `visual ${i + 1}`
        );

      }

      else if (
        typeof scene.image_prompt ===
          'string' &&
        scene.image_prompt.trim()
      ) {

        await generateImageWithRetry(
          scene.image_prompt,
          imagePath,
          i + 1,
          jobId
        );

      }

      else {

        throw new Error(
          `Visual ${i + 1} has no image_url/image_prompt`
        );
      }


      imageFiles.push(
        imagePath
      );


      updateJob(
        jobId,
        {
          progress:
            5 +
            Math.round(
              (
                (i + 1) /
                scenes.length
              ) *
              22
            ),

          currentStep:
            `images_${i + 1}_of_${scenes.length}`,
        }
      );


      await sleep(80);
    }


    // ========================================================
    // AUDIO
    // ========================================================

    updateJob(
      jobId,
      {
        progress: 30,

        currentStep:
          'downloading_audio',
      }
    );


    const audioFiles = [];


    for (
      let i = 0;
      i < audioParts.length;
      i++
    ) {

      const audioUrl =
        safeString(
          audioParts[i]?.audio_url
        ).trim();


      if (!audioUrl) {

        throw new Error(
          `Audio ${i + 1} missing audio_url`
        );
      }


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
        audioUrl,
        audioPath,
        jobId,
        `audio ${i + 1}`
      );


      audioFiles.push(
        audioPath
      );
    }


    // ========================================================
    // AUDIO MERGE
    // ========================================================

    updateJob(
      jobId,
      {
        progress: 35,

        currentStep:
          'merging_audio',
      }
    );


    const finalAudio =
      await mergeAudio(
        audioFiles,
        workDir,
        jobId
      );


    const audioDuration =
      await getMediaDuration(
        finalAudio,
        jobId
      );


    const imageCount =
      imageFiles.length;


    // ========================================================
    // TIMING
    // ========================================================

    const clipDuration =
      (
        audioDuration +
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
      visibleStepDuration <=
      0
    ) {

      throw new Error(
        'Visual duration calculation failed'
      );
    }


    console.log(
      `[${jobId}] audio=${audioDuration.toFixed(2)} sec`
    );

    console.log(
      `[${jobId}] visible/shot=${visibleStepDuration.toFixed(2)} sec`
    );


    updateJob(
      jobId,
      {
        audioDuration,

        sceneDuration:
          visibleStepDuration,

        clipDuration,

        transitionDuration,

        progress: 40,

        currentStep:
          'building_filters',
      }
    );


    // ========================================================
    // FFMPEG INPUTS
    // ========================================================

    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-y',
    ];


    for (
      const imageFile
      of imageFiles
    ) {

      args.push(
        '-loop',
        '1',

        '-framerate',
        String(fps),

        '-t',
        clipDuration.toFixed(
          6
        ),

        '-i',
        imageFile
      );
    }


    args.push(
      '-i',
      finalAudio
    );


    // ========================================================
    // FILTER GRAPH
    // ========================================================

    const filters = [];


    for (
      let i = 0;
      i < imageCount;
      i++
    ) {

      const scene =
        scenes[i] || {};


      const useMotion =
        shouldUseMotion(
          scene,
          i
        );


      // ------------------------------------------------------
      // MOVING SHOT
      // ------------------------------------------------------

      if (useMotion) {

        const motion =
          buildZoomExpression(
            i
          );


        filters.push(

          `[${i}:v]` +

          `scale=` +
          `${width}:${height}:` +
          `force_original_aspect_ratio=increase,` +

          `crop=` +
          `${width}:${height},` +

          `zoompan=` +
          `z='${motion.zoom}':` +
          `x='${motion.x}':` +
          `y='${motion.y}':` +
          `d=1:` +
          `s=${width}x${height}:` +
          `fps=${fps},` +

          `settb=AVTB,` +
          `setpts=PTS-STARTPTS,` +
          `setsar=1,` +
          `format=yuv420p` +

          `[v${i}]`

        );

      }

      // ------------------------------------------------------
      // STATIC DETAIL SHOT
      //
      // 不跑 zoompan，CPU 需求低很多
      // ------------------------------------------------------

      else {

        filters.push(

          `[${i}:v]` +

          `scale=` +
          `${width}:${height}:` +
          `force_original_aspect_ratio=increase,` +

          `crop=` +
          `${width}:${height},` +

          `fps=${fps},` +

          `settb=AVTB,` +
          `setpts=PTS-STARTPTS,` +
          `setsar=1,` +
          `format=yuv420p` +

          `[v${i}]`

        );
      }
    }


    // ========================================================
    // CROSSFADE
    // ========================================================

    let previous =
      'v0';


    if (
      imageCount > 1
    ) {

      for (
        let i = 1;
        i < imageCount;
        i++
      ) {

        const outputLabel =
          `xf${i}`;


        const offset =
          visibleStepDuration *
          i;


        filters.push(

          `[${previous}]` +
          `[v${i}]` +

          `xfade=` +
          `transition=${transitionType}:` +
          `duration=${transitionDuration.toFixed(6)}:` +
          `offset=${offset.toFixed(6)}` +

          `[${outputLabel}]`

        );


        previous =
          outputLabel;
      }
    }


    const filterComplex =
      filters.join(
        ';'
      );


    // ========================================================
    // OUTPUT
    // ========================================================

    const outputPath =
      path.join(
        OUTPUT_DIR,
        `${jobId}.mp4`
      );


    args.push(
      '-filter_complex',
      filterComplex,

      '-map',
      `[${previous}]`,

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

      '-pix_fmt',
      'yuv420p',

      '-c:a',
      'aac',

      '-b:a',
      '160k',

      '-ar',
      '44100',

      '-ac',
      '2',

      '-r',
      String(fps),

      '-t',
      audioDuration.toFixed(
        6
      ),

      '-movflags',
      '+faststart',

      outputPath
    );


    // ========================================================
    // RENDER
    // ========================================================

    updateJob(
      jobId,
      {
        progress: 48,

        currentStep:
          'ffmpeg_rendering',
      }
    );


    console.log(
      `[${jobId}] FAST cinematic render started`
    );


    await runProcess(
      'ffmpeg',
      args,
      {
        timeoutMs:
          MAX_RENDER_MS,

        jobId,

        label:
          'final FFmpeg render',
      }
    );


    // ========================================================
    // VALIDATE OUTPUT
    // ========================================================

    if (
      !fs.existsSync(
        outputPath
      )
    ) {

      throw new Error(
        'Final MP4 not created'
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
        `Final MP4 too small: ${outputSize}`
      );
    }


    const outputDuration =
      await getMediaDuration(
        outputPath,
        jobId
      );


    updateJob(
      jobId,
      {
        status:
          'completed',

        progress:
          100,

        currentStep:
          'completed',

        timeoutReached:
          false,

        outputPath,

        outputSize,

        outputDuration,

        completedAt:
          new Date().toISOString(),

        error:
          null,
      }
    );


    console.log(
      `[${jobId}] completed`
    );

    console.log(
      `[${jobId}] duration=${outputDuration.toFixed(2)} sec`
    );

    console.log(
      `[${jobId}] size=${(
        outputSize /
        1024 /
        1024
      ).toFixed(2)} MB`
    );

  }

  catch (error) {

    const message =
      safeString(
        error?.message ||
        error
      ).slice(
        0,
        30000
      );


    const timedOut =
      message.includes(
        'exceeded maximum runtime'
      );


    console.error(
      `[${jobId}] FAILED:`,
      message
    );


    updateJob(
      jobId,
      {
        status:
          'failed',

        currentStep:
          timedOut
            ? 'render_timeout'
            : 'failed',

        timeoutReached:
          timedOut,

        error:
          timedOut
            ? (
                `FFmpeg 超過 ${MAX_RENDER_MINUTES} 分鐘，` +
                `已由 Render Server 強制停止。`
              )
            : message,
      }
    );

  }

  finally {

    try {

      fs.rmSync(
        workDir,
        {
          recursive: true,
          force: true,
        }
      );

    } catch (error) {

      console.error(
        `[${jobId}] cleanup failed`,
        error
      );
    }

  }
}


// ============================================================
// HEALTH
// ============================================================

app.get(
  '/',
  (
    req,
    res
  ) => {

    return res.json({

      status:
        'ok',

      service:
        'n8n-ffmpeg-render',

      version:
        '3.0-fast',

      mode:
        'environmental-horror-fast',

      default_resolution:
        `${DEFAULT_WIDTH}x${DEFAULT_HEIGHT}`,

      default_fps:
        DEFAULT_FPS,

      default_crf:
        DEFAULT_CRF,

      default_preset:
        DEFAULT_PRESET,

      default_transition:
        DEFAULT_TRANSITION_DURATION,

      max_render_minutes:
        MAX_RENDER_MINUTES,

      max_concurrent_renders:
        MAX_CONCURRENT_RENDERS,

      active_renders:
        activeRenders,

      queued_renders:
        renderQueue.length,

      image_priority:
        'image_url-first',

      cloudflare_fallback:
        Boolean(
          CLOUDFLARE_ACCOUNT_ID &&
          CLOUDFLARE_API_TOKEN
        ),

      features: [
        '24-visual-support',
        'multi-shot-support',
        'selective-ken-burns',
        'static-detail-shots',
        'crossfade',
        '720p-optimized',
        '24fps-optimized',
        'ultrafast-h264',
        'multi-part-audio',
        'render-queue',
        'elapsed-time',
        'hard-timeout',
      ],

    });
  }
);


// ============================================================
// CREATE RENDER JOB
// ============================================================

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


    const hasAudioParts =
      Array.isArray(
        payload.audio_parts
      ) &&
      payload.audio_parts.length >
        0;


    if (
      !hasAudioParts &&
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


    const now =
      new Date().toISOString();


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

        timeoutReached:
          false,

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

        outputDuration:
          null,

        outputSize:
          null,

        outputPath:
          null,

        createdAt:
          now,

        renderStartedAt:
          null,

        completedAt:
          null,

        updatedAt:
          now,
      }
    );


    enqueueRender(
      jobId,
      payload
    );


    return res
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


// ============================================================
// STATUS
// ============================================================

app.get(
  '/status/:jobId',
  checkApiKey,
  (
    req,
    res
  ) => {

    const jobId =
      req.params.jobId;


    const job =
      loadJob(
        jobId
      );


    if (!job) {

      return res
        .status(404)
        .json({
          error:
            'Job not found',
        });
    }


    let elapsedSeconds =
      null;

    let elapsedMinutes =
      null;


    if (
      job.createdAt
    ) {

      const createdTime =
        new Date(
          job.createdAt
        ).getTime();


      if (
        Number.isFinite(
          createdTime
        )
      ) {

        elapsedSeconds =
          Math.max(
            0,
            Math.floor(
              (
                Date.now() -
                createdTime
              ) /
              1000
            )
          );


        elapsedMinutes =
          Number(
            (
              elapsedSeconds /
              60
            ).toFixed(2)
          );
      }
    }


    return res.json({

      job_id:
        jobId,

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

      elapsed_seconds:
        elapsedSeconds,

      elapsed_minutes:
        elapsedMinutes,

      timeout_reached:
        job.timeoutReached ??
        false,

      max_render_minutes:
        MAX_RENDER_MINUTES,

      error:
        job.error ??
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

      created_at:
        job.createdAt ??
        null,

      render_started_at:
        job.renderStartedAt ??
        null,

      updated_at:
        job.updatedAt ??
        null,

      completed_at:
        job.completedAt ??
        null,

    });
  }
);


// ============================================================
// DOWNLOAD
// ============================================================

app.get(
  '/download/:jobId',
  checkApiKey,
  (
    req,
    res
  ) => {

    const jobId =
      req.params.jobId;


    const job =
      loadJob(
        jobId
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

          timeout_reached:
            job.timeoutReached ??
            false,

          detail:
            job.error ??
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


    return res.download(
      job.outputPath,
      'final_video.mp4'
    );
  }
);


// ============================================================
// DEBUG JOB
// ============================================================

app.get(
  '/job/:jobId',
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


    return res.json(job);
  }
);


// ============================================================
// 404
// ============================================================

app.use(
  (
    req,
    res
  ) => {

    return res
      .status(404)
      .json({
        error:
          'Route not found',
      });
  }
);


// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      'Express error:',
      error
    );


    if (
      res.headersSent
    ) {

      return next(error);
    }


    return res
      .status(500)
      .json({

        error:
          'Internal server error',

        detail:
          safeString(
            error?.message ||
            error
          ),

      });
  }
);


// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      '=============================================='
    );

    console.log(
      'n8n FFmpeg Render 3.0 FAST'
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Default video: ${DEFAULT_WIDTH}x${DEFAULT_HEIGHT} / ${DEFAULT_FPS}fps`
    );

    console.log(
      `H264 preset: ${DEFAULT_PRESET}`
    );

    console.log(
      `CRF: ${DEFAULT_CRF}`
    );

    console.log(
      `Transition: ${DEFAULT_TRANSITION_DURATION}s`
    );

    console.log(
      `Hard timeout: ${MAX_RENDER_MINUTES} minutes`
    );

    console.log(
      'Motion strategy: establishing moves / detail stays stable'
    );

    console.log(
      '=============================================='
    );

  }
);
