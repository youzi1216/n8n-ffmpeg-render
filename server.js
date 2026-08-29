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
// RENDER LIMITS
// ============================================================

// 免費 Render 建議一次只 Render 一支
const MAX_CONCURRENT_RENDERS =
  Math.max(
    1,
    Number(
      process.env.MAX_CONCURRENT_RENDERS || 1
    )
  );

// FFmpeg 最長允許執行時間
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
      `[${jobId}] loadJob error:`,
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
        error:
          'Unauthorized',
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

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
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


// ============================================================
// RUN PROCESS
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

      let stdout =
        '';

      let stderr =
        '';

      let killedByTimeout =
        false;

      let timeoutHandle =
        null;


      child.stdout.on(
        'data',
        chunk => {

          stdout +=
            chunk.toString();

          // 防止記憶體無限制累積
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

          const text =
            chunk.toString();

          stderr +=
            text;

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
        timeoutMs > 0
      ) {

        timeoutHandle =
          setTimeout(
            () => {

              killedByTimeout =
                true;

              console.error(
                `[${jobId}] ${label} exceeded timeout ` +
                `${Math.round(timeoutMs / 60000)} minutes`
              );

              try {
                child.kill(
                  'SIGTERM'
                );
              } catch (_) {
                // ignore
              }

              // SIGTERM 沒停再強制殺
              setTimeout(
                () => {

                  try {

                    if (
                      !child.killed
                    ) {
                      child.kill(
                        'SIGKILL'
                      );
                    }

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

          reject(
            error
          );
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
            killedByTimeout
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
                  -10000
                )
              )
            );
          }


          resolve({
            stdout,
            stderr,
          });

        }
      );

    }
  );
}


// ============================================================
// DOWNLOAD
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
        `[${jobId}] downloading ${label} ` +
        `(attempt ${attempt}/${maxAttempts})`
      );


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
                'Mozilla/5.0 n8n-render/2.0',
            },
          }
        );


      if (
        !response.ok
      ) {

        const text =
          await response.text();

        throw new Error(
          `HTTP ${response.status} ` +
          `${response.statusText}: ` +
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
        500
      ) {

        throw new Error(
          `${label} download too small: ` +
          `${buffer.length} bytes`
        );
      }


      fs.writeFileSync(
        outputPath,
        buffer
      );


      console.log(
        `[${jobId}] ${label} downloaded ` +
        `(${(
          buffer.length /
          1024
        ).toFixed(1)} KB)`
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
          3000
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
realistic architectural proportions,
realistic materials and textures,
subtle unsettling environmental details,
cold desaturated color grading,
deep shadows,
soft volumetric lighting,
low saturation,
atmospheric suspense,
high detail,
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


  const enhanced =
    buildEnhancedPrompt(
      prompt
    );


  if (!enhanced) {
    throw new Error(
      `Visual ${visualIndex} has empty image_prompt`
    );
  }


  const url =
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${CLOUDFLARE_ACCOUNT_ID}` +
    `/ai/run/` +
    `${CLOUDFLARE_MODEL}`;


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
              enhanced.slice(
                0,
                2400
              ),

            steps:
              6,
          }),
      }
    );


  if (
    !response.ok
  ) {

    const text =
      await response.text();

    throw new Error(
      `Cloudflare error ${response.status}: ` +
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
        `Cloudflare returned no image: ` +
        JSON.stringify(
          json
        ).slice(
          0,
          1000
        )
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
        1000
      )
    );
  }


  if (
    !buffer ||
    buffer.length <
    10000
  ) {

    throw new Error(
      `Generated visual ${visualIndex} is invalid`
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

      console.log(
        `[${jobId}] Cloudflare fallback ` +
        `${visualIndex}, attempt ${attempt}`
      );


      await generateCloudflareImage(
        prompt,
        outputPath,
        visualIndex,
        jobId
      );


      return;

    } catch (error) {

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


// ============================================================
// FFPROBE
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
      `Unable to detect duration: ${filePath}`
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

    console.log(
      `[${jobId}] one audio part, merge skipped`
    );

    return audioFiles[0];
  }


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


  const lines =
    audioFiles.map(
      file => {

        const escaped =
          file.replace(
            /'/g,
            "'\\''"
          );

        return (
          `file '${escaped}'`
        );
      }
    );


  fs.writeFileSync(
    listPath,
    lines.join('\n')
  );


  console.log(
    `[${jobId}] merging ` +
    `${audioFiles.length} audio parts`
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
      '192k',

      '-ar',
      '48000',

      '-ac',
      '2',

      mergedPath,
    ],

    {
      timeoutMs:
        5 * 60 * 1000,

      jobId,

      label:
        'audio merge',
    }
  );


  return mergedPath;
}


// ============================================================
// SHOT TYPE
// ============================================================

function normalizeShotType(value) {

  return safeString(
    value
  )
    .trim()
    .toLowerCase()
    .replace(
      /[\s-]+/g,
      '_'
    );
}


// ============================================================
// CINEMATIC MOTION
// ============================================================

function buildMotion(
  scene,
  index
) {

  const shotType =
    normalizeShotType(
      scene.shot_type
    );


  // ------------------------------------------
  // Detail / close-up：
  // 輕微推近，強調線索
  // ------------------------------------------

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

    return {

      zoom:
        'min(zoom+0.00020,1.050)',

      x:
        'iw/2-(iw/zoom/2)',

      y:
        'ih/2-(ih/zoom/2)',
    };
  }


  // ------------------------------------------
  // Establishing / wide：
  // 非常慢的空間推進
  // ------------------------------------------

  if (
    [
      'establishing',
      'wide',
      'environment',
    ].includes(
      shotType
    )
  ) {

    return {

      zoom:
        'min(zoom+0.00011,1.030)',

      x:
        index % 2 === 0
          ? 'iw/2-(iw/zoom/2)'
          : 'iw/2-(iw/zoom/2)+((iw-iw/zoom)*0.025)',

      y:
        'ih/2-(ih/zoom/2)',
    };
  }


  // ------------------------------------------
  // 其他：
  // 交替輕微左右偏移
  // ------------------------------------------

  return {

    zoom:
      'min(zoom+0.00015,1.040)',

    x:
      index % 2 === 0
        ? 'iw/2-(iw/zoom/2)-((iw-iw/zoom)*0.018)'
        : 'iw/2-(iw/zoom/2)+((iw-iw/zoom)*0.018)',

    y:
      'ih/2-(ih/zoom/2)',
  };
}


// ============================================================
// TRANSITION
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

  const candidate =
    safeString(
      value,
      'fade'
    )
      .trim()
      .toLowerCase();


  return ALLOWED_TRANSITIONS.has(
    candidate
  )
    ? candidate
    : 'fade';
}


// ============================================================
// QUEUE
// ============================================================

const renderQueue =
  [];

let activeRenders =
  0;


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
      status:
        'queued',

      queuePosition:
        renderQueue.length,

      progress:
        0,

      currentStep:
        'queued',
    }
  );


  processQueue()
    .catch(
      error => {

        console.error(
          'processQueue error:',
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
            `[${next.jobId}] render uncaught error`,
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
                  'queue continuation error:',
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
        'No scenes provided'
      );
    }


    if (
      audioParts.length === 0
    ) {

      throw new Error(
        'No audio_parts or audio_url provided'
      );
    }


    // ========================================================
    // SORT
    // ========================================================

    scenes.sort(
      (
        a,
        b
      ) => {

        const aRender =
          safeNumber(
            a.render_index,
            safeNumber(
              a.scene_number,
              0
            )
          );


        const bRender =
          safeNumber(
            b.render_index,
            safeNumber(
              b.scene_number,
              0
            )
          );


        if (
          aRender !==
          bRender
        ) {

          return (
            aRender -
            bRender
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
      safeString(
        settings.preset,
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


    console.log(
      `[${jobId}] visuals: ${scenes.length}`
    );

    console.log(
      `[${jobId}] audio parts: ${audioParts.length}`
    );


    // ========================================================
    // IMAGES
    // ========================================================

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
      i < scenes.length;
      i++
    ) {

      const scene =
        scenes[i] || {};


      const originalSceneNumber =
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


      // ------------------------------------------------------
      // 最高優先：直接使用 n8n 已生成圖片
      // ------------------------------------------------------

      if (
        typeof scene.image_url ===
          'string' &&
        scene.image_url.trim()
      ) {

        await downloadFile(
          scene.image_url.trim(),
          imagePath,
          jobId,
          `visual ${i + 1}/${scenes.length}`
        );

      }

      // ------------------------------------------------------
      // 沒有 image_url 才 Cloudflare fallback
      // ------------------------------------------------------

      else if (
        typeof scene.image_prompt ===
          'string' &&
        scene.image_prompt.trim()
      ) {

        console.log(
          `[${jobId}] image_url missing for ` +
          `scene ${originalSceneNumber} shot ${shotIndex}; ` +
          `Cloudflare fallback`
        );


        await generateImageWithRetry(
          scene.image_prompt,
          imagePath,
          i + 1,
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
              25
            ),

          currentStep:
            `images_${i + 1}_of_${scenes.length}`,
        }
      );


      // Drive 不需要長時間等待
      await sleep(
        100
      );

    }


    // ========================================================
    // AUDIO DOWNLOAD
    // ========================================================

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
      i < audioParts.length;
      i++
    ) {

      const part =
        audioParts[i];


      const audioUrl =
        safeString(
          part.audio_url
        ).trim();


      if (!audioUrl) {

        throw new Error(
          `Audio part ${i + 1} missing audio_url`
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
        `audio ${i + 1}/${audioParts.length}`
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
        progress:
          37,

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


    console.log(
      `[${jobId}] audio duration: ` +
      `${audioDuration.toFixed(2)} sec`
    );


    // ========================================================
    // DURATION CALCULATION
    // ========================================================

    const imageCount =
      imageFiles.length;


    /*
      Crossfade 後總長：

      final =
      N * clipDuration
      - (N - 1) * transition

      因此：

      clipDuration =
      (
        audioDuration +
        (N - 1) * transition
      ) / N
    */


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
      visibleStepDuration <= 0
    ) {

      throw new Error(
        'Calculated visual duration is invalid'
      );
    }


    updateJob(
      jobId,
      {
        audioDuration,

        sceneDuration:
          visibleStepDuration,

        clipDuration,

        transitionDuration,

        progress:
          42,

        currentStep:
          'building_ffmpeg',
      }
    );


    console.log(
      `[${jobId}] per visual visible duration: ` +
      `${visibleStepDuration.toFixed(2)} sec`
    );


    // ========================================================
    // FFMPEG INPUTS
    // ========================================================

    const args = [
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


    // 最後一個 input 是 audio
    args.push(
      '-i',
      finalAudio
    );


    // ========================================================
    // FILTERS
    // ========================================================

    const filters =
      [];


    // --------------------------------------------------------
    // Ken Burns
    // --------------------------------------------------------

    const workingWidth =
      Math.round(
        width *
        1.08
      );


    const workingHeight =
      Math.round(
        height *
        1.08
      );


    for (
      let i = 0;
      i < imageCount;
      i++
    ) {

      const motion =
        buildMotion(
          scenes[i] || {},
          i
        );


      filters.push(

        `[${i}:v]` +

        `scale=` +
        `${workingWidth}:` +
        `${workingHeight}:` +
        `force_original_aspect_ratio=increase,` +

        `crop=` +
        `${workingWidth}:` +
        `${workingHeight},` +

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


    // --------------------------------------------------------
    // Crossfade
    // --------------------------------------------------------

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

        const output =
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

          `[${output}]`

        );


        previous =
          output;
      }
    }


    const filterComplex =
      filters.join(
        ';'
      );


    // ========================================================
    // FINAL OUTPUT
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

      '-t',
      audioDuration.toFixed(
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


    console.log(
      `[${jobId}] FFmpeg cinematic render starting`
    );

    console.log(
      `[${jobId}] ` +
      `${width}x${height} | ` +
      `${fps}fps | ` +
      `${imageCount} visuals | ` +
      `${transitionDuration}s crossfade | ` +
      `hard timeout ${MAX_RENDER_MINUTES} min`
    );


    // ========================================================
    // IMPORTANT:
    // 真正 25 分鐘硬超時
    // ========================================================

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
    // VALIDATE
    // ========================================================

    if (
      !fs.existsSync(
        outputPath
      )
    ) {

      throw new Error(
        'FFmpeg completed but output video does not exist'
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
        `Output video too small: ${outputSize} bytes`
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
      `[${jobId}] render completed`
    );

    console.log(
      `[${jobId}] duration: ` +
      `${outputDuration.toFixed(2)} sec`
    );

    console.log(
      `[${jobId}] size: ` +
      `${(
        outputSize /
        1024 /
        1024
      ).toFixed(2)} MB`
    );

  }

  // ==========================================================
  // ERROR / TIMEOUT
  // ==========================================================

  catch (error) {

    const message =
      safeString(
        error?.message ||
        error
      ).slice(
        0,
        30000
      );


    console.error(
      `[${jobId}] render failed:`,
      message
    );


    const timedOut =
      message.includes(
        'exceeded maximum runtime'
      );


    updateJob(
      jobId,
      {
        status:
          'failed',

        progress:
          null,

        currentStep:
          timedOut
            ? 'render_timeout'
            : 'failed',

        timeoutReached:
          timedOut,

        error:
          timedOut
            ? (
                `Render exceeded ${MAX_RENDER_MINUTES} minutes ` +
                `and FFmpeg was terminated automatically.`
              )
            : message,
      }
    );

  }

  // ==========================================================
  // CLEANUP
  // ==========================================================

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
        `[${jobId}] cleanup error:`,
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

    res.json({

      status:
        'ok',

      service:
        'n8n-ffmpeg-render',

      version:
        '2.0-cinematic',

      render_mode:
        'environmental-horror',

      image_priority:
        'image_url_first',

      image_fallback:
        'cloudflare',

      cloudflare_account:
        CLOUDFLARE_ACCOUNT_ID
          ? 'configured'
          : 'missing',

      cloudflare_token:
        CLOUDFLARE_API_TOKEN
          ? 'configured'
          : 'missing',

      cloudflare_model:
        CLOUDFLARE_MODEL,

      default_video:
        '1920x1080-30fps',

      features: [
        '24-visual-support',
        'multi-shot',
        'image-url-first',
        'cloudflare-fallback',
        'ken-burns',
        'shot-aware-motion',
        'crossfade',
        'multi-part-audio',
        'audio-sync',
        'render-queue',
        'elapsed-time',
        'hard-render-timeout',
      ],

      max_concurrent_renders:
        MAX_CONCURRENT_RENDERS,

      max_render_minutes:
        MAX_RENDER_MINUTES,

      active_renders:
        activeRenders,

      queued_renders:
        renderQueue.length,

    });
  }
);


// ============================================================
// CREATE JOB
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


    const createdAt =
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

        createdAt,

        renderStartedAt:
          null,

        completedAt:
          null,

        updatedAt:
          createdAt,
      }
    );


    enqueueRender(
      jobId,
      payload
    );


    console.log(
      `[${jobId}] render job created`
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


    // ========================================================
    // ELAPSED TIME
    // ========================================================

    let elapsedSeconds =
      null;

    let elapsedMinutes =
      null;


    if (
      job.createdAt
    ) {

      const created =
        new Date(
          job.createdAt
        ).getTime();


      if (
        Number.isFinite(
          created
        )
      ) {

        elapsedSeconds =
          Math.max(
            0,
            Math.floor(
              (
                Date.now() -
                created
              ) /
              1000
            )
          );


        elapsedMinutes =
          Number(
            (
              elapsedSeconds /
              60
            ).toFixed(
              2
            )
          );
      }
    }


    // ========================================================
    // STATUS RESPONSE
    // ========================================================

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
            'Rendered video file not found',
        });
    }


    console.log(
      `[${jobId}] video download requested`
    );


    return res.download(
      job.outputPath,
      'final_video.mp4'
    );
  }
);


// ============================================================
// OPTIONAL JOB DEBUG
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


    return res.json(
      job
    );
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
// GLOBAL ERROR
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

      return next(
        error
      );
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
      '========================================'
    );

    console.log(
      `n8n FFmpeg Render v2 running`
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Max concurrent renders: ${MAX_CONCURRENT_RENDERS}`
    );

    console.log(
      `Hard render timeout: ${MAX_RENDER_MINUTES} minutes`
    );

    console.log(
      `Cloudflare model: ${CLOUDFLARE_MODEL}`
    );

    console.log(
      'Image priority: image_url -> Cloudflare fallback'
    );

    console.log(
      'Video mode: 1080p cinematic Environmental Horror'
    );

    console.log(
      'Effects: Shot-aware Ken Burns + Crossfade'
    );

    console.log(
      '========================================'
    );

  }
);
