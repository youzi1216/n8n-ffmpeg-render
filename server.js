const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();

app.use(
  express.json({
    limit: '50mb'
  })
);


// ============================================================
// ENV
// ============================================================

const PORT =
  Number(
    process.env.PORT ||
    3000
  );

const API_KEY =
  String(
    process.env.API_KEY ||
    ''
  ).trim();


// ============================================================
// HARD VIDEO SETTINGS
//
// 1600x900
// 24fps
// ultrafast
// CRF22
// ============================================================

const WIDTH =
  1600;

const HEIGHT =
  900;

const FPS =
  24;

const CRF =
  22;

const PRESET =
  'ultrafast';

const THREADS =
  2;


// ============================================================
// TRANSITION
// ============================================================

const FADE_DURATION =
  0.18;


// ============================================================
// TIMEOUT
//
// 900p 比 720p 負擔高。
// 先放到 45 分鐘避免誤殺正常 Render。
// ============================================================

const HARD_TIMEOUT_MINUTES =
  45;

const HARD_TIMEOUT_MS =
  HARD_TIMEOUT_MINUTES *
  60 *
  1000;


// ============================================================
// PATH
// ============================================================

const ROOT =
  '/tmp/n8n-render-900p';

const JOBS_DIR =
  path.join(
    ROOT,
    'jobs'
  );

const OUTPUT_DIR =
  path.join(
    ROOT,
    'outputs'
  );

fs.mkdirSync(
  JOBS_DIR,
  {
    recursive: true
  }
);

fs.mkdirSync(
  OUTPUT_DIR,
  {
    recursive: true
  }
);


// ============================================================
// JOB STORAGE
// ============================================================

function getJobPath(jobId) {

  return path.join(
    JOBS_DIR,
    `${jobId}.json`
  );

}


function saveJob(
  jobId,
  data
) {

  fs.writeFileSync(
    getJobPath(jobId),
    JSON.stringify(
      data,
      null,
      2
    )
  );

}


function loadJob(jobId) {

  const file =
    getJobPath(jobId);


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
      'loadJob:',
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
    loadJob(jobId) ||
    {};


  const updated = {

    ...current,

    ...changes,

    updatedAt:
      new Date()
        .toISOString()
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


  const given =
    String(
      req.headers[
        'x-api-key'
      ] ||
      ''
    );


  if (
    given !==
    API_KEY
  ) {

    return res
      .status(401)
      .json({
        error:
          'Unauthorized'
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


function normalizeShotType(value) {

  return String(
    value ??
    ''
  )
    .trim()
    .toLowerCase()
    .replace(
      /[\s-]+/g,
      '_'
    );

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

    timeoutMs =
      0,

    jobId =
      '',

    label =
      command

  } = options;


  return new Promise(
    (
      resolve,
      reject
    ) => {

      console.log(
        `[${jobId}] START ${label}`
      );


      const child =
        spawn(
          command,
          args,
          {
            stdio: [
              'ignore',
              'pipe',
              'pipe'
            ]
          }
        );


      let stdout =
        '';

      let stderr =
        '';

      let timedOut =
        false;

      let timer =
        null;


      child.stdout.on(
        'data',
        chunk => {

          stdout +=
            chunk.toString();


          if (
            stdout.length >
            1000000
          ) {

            stdout =
              stdout.slice(
                -500000
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
            3000000
          ) {

            stderr =
              stderr.slice(
                -1000000
              );

          }

        }
      );


      if (
        timeoutMs >
        0
      ) {

        timer =
          setTimeout(
            () => {

              timedOut =
                true;


              console.error(
                `[${jobId}] TIMEOUT ${label}`
              );


              try {

                child.kill(
                  'SIGTERM'
                );

              } catch (_) {}


              setTimeout(
                () => {

                  try {

                    child.kill(
                      'SIGKILL'
                    );

                  } catch (_) {}

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

          if (timer) {
            clearTimeout(timer);
          }


          reject(error);

        }
      );


      child.on(
        'close',
        code => {

          if (timer) {
            clearTimeout(timer);
          }


          if (timedOut) {

            return reject(
              new Error(
                `${label} timeout`
              )
            );

          }


          if (
            code !==
            0
          ) {

            return reject(
              new Error(
                `${label} failed (${code})\n` +
                stderr.slice(
                  -8000
                )
              )
            );

          }


          resolve({
            stdout,
            stderr
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
  output,
  jobId,
  label
) {

  let lastError =
    null;


  for (
    let attempt = 1;
    attempt <= 4;
    attempt++
  ) {

    try {

      console.log(
        `[${jobId}] Download ${label} ${attempt}/4`
      );


      const response =
        await fetch(
          url,
          {
            redirect:
              'follow',

            headers: {
              'User-Agent':
                'Mozilla/5.0 n8n-render-900p'
            }
          }
        );


      if (
        !response.ok
      ) {

        throw new Error(
          `HTTP ${response.status}`
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
          'Downloaded file too small'
        );

      }


      fs.writeFileSync(
        output,
        buffer
      );


      return;

    } catch (error) {

      lastError =
        error;


      if (
        attempt <
        4
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
// MEDIA DURATION
// ============================================================

async function getDuration(
  file,
  jobId
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

        file
      ],
      {
        timeoutMs:
          60000,

        jobId,

        label:
          'ffprobe'
      }
    );


  const duration =
    Number(
      result.stdout.trim()
    );


  if (
    !Number.isFinite(duration) ||
    duration <= 0
  ) {

    throw new Error(
      'Invalid duration'
    );

  }


  return duration;

}


// ============================================================
// AUDIO MERGE
// ============================================================

async function mergeAudio(
  files,
  workDir,
  jobId
) {

  if (
    files.length ===
    1
  ) {

    return files[0];

  }


  const listFile =
    path.join(
      workDir,
      'audio.txt'
    );


  const output =
    path.join(
      workDir,
      'audio.m4a'
    );


  const content =
    files
      .map(
        file =>
          `file '${file.replace(/'/g, "'\\''")}'`
      )
      .join('\n');


  fs.writeFileSync(
    listFile,
    content
  );


  await runProcess(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',

      '-f',
      'concat',

      '-safe',
      '0',

      '-i',
      listFile,

      '-vn',

      '-c:a',
      'aac',

      '-b:a',
      '160k',

      '-ar',
      '44100',

      '-ac',
      '2',

      output
    ],
    {
      timeoutMs:
        5 *
        60 *
        1000,

      jobId,

      label:
        'merge audio'
    }
  );


  return output;

}


// ============================================================
// MOTION
// ============================================================

function useMotion(scene) {

  const type =
    normalizeShotType(
      scene.shot_type
    );


  return [
    'establishing',
    'wide',
    'environment'
  ].includes(type);

}


// ============================================================
// CREATE ONE VISUAL CLIP
// ============================================================

async function createVisualClip(
  image,
  output,
  duration,
  scene,
  index,
  jobId
) {

  const motion =
    useMotion(scene);


  const fadeOutStart =
    Math.max(
      0,
      duration -
      FADE_DURATION
    );


  let videoFilter;


  // ==========================================================
  // Moving shot
  // ==========================================================

  if (motion) {

    const frames =
      Math.ceil(
        duration *
        FPS
      );


    const horizontalOffset =
      index %
      2 ===
      0
        ? 0
        : 0.012;


    videoFilter =
      [

        // 先稍微放大，避免 zoompan 邊緣不足
        `scale=1664:936:force_original_aspect_ratio=increase`,

        `crop=1664:936`,

        `zoompan=` +
          `z='min(zoom+0.000065,1.016)':` +
          `x='iw/2-(iw/zoom/2)+((iw-iw/zoom)*${horizontalOffset})':` +
          `y='ih/2-(ih/zoom/2)':` +
          `d=${frames}:` +
          `s=${WIDTH}x${HEIGHT}:` +
          `fps=${FPS}`,

        `fade=t=in:st=0:d=${FADE_DURATION}`,

        `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${FADE_DURATION}`,

        `format=yuv420p`

      ]
        .join(',');

  }

  // ==========================================================
  // Static detail
  // ==========================================================

  else {

    videoFilter =
      [

        `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase`,

        `crop=${WIDTH}:${HEIGHT}`,

        `fps=${FPS}`,

        `fade=t=in:st=0:d=${FADE_DURATION}`,

        `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${FADE_DURATION}`,

        `format=yuv420p`

      ]
        .join(',');

  }


  await runProcess(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',

      '-loop',
      '1',

      '-framerate',
      String(FPS),

      '-i',
      image,

      '-t',
      duration.toFixed(3),

      '-vf',
      videoFilter,

      '-an',

      '-c:v',
      'libx264',

      '-preset',
      PRESET,

      '-crf',
      String(CRF),

      '-threads',
      String(THREADS),

      '-pix_fmt',
      'yuv420p',

      '-r',
      String(FPS),

      output
    ],
    {
      timeoutMs:
        Math.min(
          7 *
          60 *
          1000,
          HARD_TIMEOUT_MS
        ),

      jobId,

      label:
        `visual clip ${index + 1}`
    }
  );

}


// ============================================================
// CONCAT
// ============================================================

async function concatClips(
  clips,
  workDir,
  jobId
) {

  const list =
    path.join(
      workDir,
      'video.txt'
    );


  const output =
    path.join(
      workDir,
      'video.mp4'
    );


  fs.writeFileSync(
    list,
    clips
      .map(
        file =>
          `file '${file.replace(/'/g, "'\\''")}'`
      )
      .join('\n')
  );


  await runProcess(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',

      '-f',
      'concat',

      '-safe',
      '0',

      '-i',
      list,

      '-c',
      'copy',

      output
    ],
    {
      timeoutMs:
        5 *
        60 *
        1000,

      jobId,

      label:
        'concat visual clips'
    }
  );


  return output;

}


// ============================================================
// ATTACH AUDIO
// ============================================================

async function attachAudio(
  video,
  audio,
  output,
  duration,
  jobId
) {

  await runProcess(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',

      '-i',
      video,

      '-i',
      audio,

      '-map',
      '0:v:0',

      '-map',
      '1:a:0',

      '-c:v',
      'copy',

      '-c:a',
      'aac',

      '-b:a',
      '160k',

      '-shortest',

      '-t',
      duration.toFixed(3),

      '-movflags',
      '+faststart',

      output
    ],
    {
      timeoutMs:
        5 *
        60 *
        1000,

      jobId,

      label:
        'attach audio'
    }
  );

}


// ============================================================
// QUEUE
// ============================================================

const queue =
  [];

let active =
  false;


function enqueue(
  jobId,
  payload
) {

  queue.push({
    jobId,
    payload
  });


  updateJob(
    jobId,
    {
      status:
        'queued',

      queuePosition:
        queue.length,

      currentStep:
        'queued',

      progress:
        0
    }
  );


  runQueue();

}


async function runQueue() {

  if (active) {
    return;
  }


  if (
    !queue.length
  ) {
    return;
  }


  active =
    true;


  const next =
    queue.shift();


  queue.forEach(
    (
      item,
      index
    ) => {

      updateJob(
        item.jobId,
        {
          queuePosition:
            index + 1
        }
      );

    }
  );


  try {

    await renderJob(
      next.jobId,
      next.payload
    );

  } catch (error) {

    console.error(
      'renderJob uncaught:',
      error
    );

  } finally {

    active =
      false;


    setImmediate(
      runQueue
    );

  }

}


// ============================================================
// MAIN RENDER
// ============================================================

async function renderJob(
  jobId,
  payload
) {

  const workDir =
    path.join(
      ROOT,
      `work-${jobId}`
    );


  fs.mkdirSync(
    workDir,
    {
      recursive:
        true
    }
  );


  const startedAt =
    Date.now();


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

        renderStartedAt:
          new Date()
            .toISOString(),

        error:
          null,

        timeoutReached:
          false
      }
    );


    const scenes =
      Array.isArray(
        payload.scenes
      )
        ? [...payload.scenes]
        : [];


    const audioParts =
      Array.isArray(
        payload.audio_parts
      )
        ? [...payload.audio_parts]
        : [];


    if (
      !scenes.length
    ) {

      throw new Error(
        'No scenes'
      );

    }


    if (
      !audioParts.length
    ) {

      throw new Error(
        'No audio_parts'
      );

    }


    scenes.sort(
      (
        a,
        b
      ) =>

        safeNumber(
          a.render_index,
          0
        ) -

        safeNumber(
          b.render_index,
          0
        )
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
    // Images
    // ========================================================

    updateJob(
      jobId,
      {
        progress:
          5,

        currentStep:
          'downloading_images',

        totalVisuals:
          scenes.length
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
        scenes[i];


      const url =
        String(
          scene.image_url ??
          ''
        ).trim();


      if (!url) {

        throw new Error(
          `Visual ${i + 1} missing image_url`
        );

      }


      const file =
        path.join(
          workDir,
          `image_${String(i + 1).padStart(3, '0')}.img`
        );


      await downloadFile(
        url,
        file,
        jobId,
        `image ${i + 1}/${scenes.length}`
      );


      imageFiles.push(
        file
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
              15
            ),

          currentStep:
            `image_${i + 1}_of_${scenes.length}`
        }
      );

    }


    // ========================================================
    // Audio
    // ========================================================

    updateJob(
      jobId,
      {
        progress:
          22,

        currentStep:
          'downloading_audio'
      }
    );


    const audioFiles =
      [];


    for (
      let i = 0;
      i < audioParts.length;
      i++
    ) {

      const url =
        String(
          audioParts[i].audio_url ??
          ''
        ).trim();


      if (!url) {

        throw new Error(
          `Audio part ${i + 1} missing URL`
        );

      }


      const file =
        path.join(
          workDir,
          `audio_${String(i + 1).padStart(3, '0')}.mp3`
        );


      await downloadFile(
        url,
        file,
        jobId,
        `audio ${i + 1}`
      );


      audioFiles.push(
        file
      );

    }


    // ========================================================
    // Merge Audio
    // ========================================================

    updateJob(
      jobId,
      {
        progress:
          28,

        currentStep:
          'merging_audio'
      }
    );


    const audio =
      await mergeAudio(
        audioFiles,
        workDir,
        jobId
      );


    const audioDuration =
      await getDuration(
        audio,
        jobId
      );


    const clipDuration =
      audioDuration /
      scenes.length;


    updateJob(
      jobId,
      {

        audioDuration,

        sceneDuration:
          clipDuration,

        clipDuration,

        transitionDuration:
          FADE_DURATION,

        transitionMode:
          'dip_to_black',

        renderWidth:
          WIDTH,

        renderHeight:
          HEIGHT,

        renderFps:
          FPS,

        renderPreset:
          PRESET,

        renderCrf:
          CRF,

        progress:
          32,

        currentStep:
          'creating_visual_clips'
      }
    );


    // ========================================================
    // Render visual clips
    // ========================================================

    const clips =
      [];


    for (
      let i = 0;
      i < scenes.length;
      i++
    ) {

      if (
        Date.now() -
        startedAt >
        HARD_TIMEOUT_MS
      ) {

        throw new Error(
          'HARD_RENDER_TIMEOUT'
        );

      }


      const clip =
        path.join(
          workDir,
          `clip_${String(i + 1).padStart(3, '0')}.mp4`
        );


      await createVisualClip(
        imageFiles[i],
        clip,
        clipDuration,
        scenes[i],
        i,
        jobId
      );


      clips.push(
        clip
      );


      updateJob(
        jobId,
        {

          progress:
            32 +
            Math.round(
              (
                (i + 1) /
                scenes.length
              ) *
              50
            ),

          currentStep:
            `visual_clip_${i + 1}_of_${scenes.length}`

        }
      );

    }


    // ========================================================
    // Concat
    // ========================================================

    updateJob(
      jobId,
      {
        progress:
          84,

        currentStep:
          'concatenating_video'
      }
    );


    const video =
      await concatClips(
        clips,
        workDir,
        jobId
      );


    // ========================================================
    // Attach Audio
    // ========================================================

    updateJob(
      jobId,
      {
        progress:
          90,

        currentStep:
          'attaching_audio'
      }
    );


    const finalFile =
      path.join(
        OUTPUT_DIR,
        `${jobId}.mp4`
      );


    await attachAudio(
      video,
      audio,
      finalFile,
      audioDuration,
      jobId
    );


    // ========================================================
    // Validate
    // ========================================================

    if (
      !fs.existsSync(
        finalFile
      )
    ) {

      throw new Error(
        'Final file missing'
      );

    }


    const stat =
      fs.statSync(
        finalFile
      );


    if (
      stat.size <
      100000
    ) {

      throw new Error(
        'Final file invalid'
      );

    }


    const finalDuration =
      await getDuration(
        finalFile,
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

        outputPath:
          finalFile,

        outputSize:
          stat.size,

        outputDuration:
          finalDuration,

        timeoutReached:
          false,

        completedAt:
          new Date()
            .toISOString(),

        error:
          null
      }
    );


    console.log(
      `[${jobId}] COMPLETE`
    );

  }

  catch (error) {

    const message =
      String(
        error?.message ??
        error
      );


    const timeout =
      message ===
        'HARD_RENDER_TIMEOUT' ||
      message.includes(
        'timeout'
      );


    updateJob(
      jobId,
      {

        status:
          'failed',

        currentStep:
          timeout
            ? 'render_timeout'
            : 'failed',

        timeoutReached:
          timeout,

        error:
          timeout
            ? `Server Render 超過 ${HARD_TIMEOUT_MINUTES} 分鐘。`
            : message.slice(
                0,
                12000
              )
      }
    );


    console.error(
      `[${jobId}] FAILED`,
      message
    );

  }

  finally {

    try {

      fs.rmSync(
        workDir,
        {
          recursive:
            true,

          force:
            true
        }
      );

    } catch (_) {}

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
        '4.1-segment-900p',

      architecture:
        'individual-clips-plus-concat',

      resolution:
        `${WIDTH}x${HEIGHT}`,

      fps:
        FPS,

      preset:
        PRESET,

      crf:
        CRF,

      transition:
        'dip-to-black',

      fade_duration:
        FADE_DURATION,

      ken_burns:
        'establishing-only',

      hard_timeout_minutes:
        HARD_TIMEOUT_MINUTES,

      active,

      queue_length:
        queue.length

    });

  }
);


// ============================================================
// CREATE RENDER
// ============================================================

app.post(
  '/render',

  checkApiKey,

  (
    req,
    res
  ) => {

    const payload =
      req.body ??
      {};


    if (
      !Array.isArray(
        payload.scenes
      ) ||
      !payload.scenes.length
    ) {

      return res
        .status(400)
        .json({
          error:
            'scenes required'
        });

    }


    if (
      !Array.isArray(
        payload.audio_parts
      ) ||
      !payload.audio_parts.length
    ) {

      return res
        .status(400)
        .json({
          error:
            'audio_parts required'
        });

    }


    const jobId =
      crypto.randomUUID();


    const now =
      new Date()
        .toISOString();


    saveJob(
      jobId,
      {

        jobId,

        status:
          'queued',

        queuePosition:
          queue.length + 1,

        progress:
          0,

        currentStep:
          'queued',

        totalVisuals:
          payload.scenes.length,

        createdAt:
          now,

        updatedAt:
          now,

        renderStartedAt:
          null,

        completedAt:
          null,

        outputPath:
          null,

        outputSize:
          null,

        outputDuration:
          null,

        error:
          null,

        timeoutReached:
          false

      }
    );


    enqueue(
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
          `/download/${jobId}`

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

    const job =
      loadJob(
        req.params.jobId
      );


    if (!job) {

      return res
        .status(404)
        .json({
          error:
            'Job not found'
        });

    }


    const baseTime =
      job.renderStartedAt ??
      job.createdAt;


    let elapsedSeconds =
      0;


    if (baseTime) {

      const timestamp =
        new Date(
          baseTime
        ).getTime();


      if (
        Number.isFinite(
          timestamp
        )
      ) {

        elapsedSeconds =
          Math.max(
            0,
            Math.floor(
              (
                Date.now() -
                timestamp
              ) /
              1000
            )
          );

      }

    }


    return res.json({

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

      elapsed_seconds:
        elapsedSeconds,

      elapsed_minutes:
        Number(
          (
            elapsedSeconds /
            60
          ).toFixed(2)
        ),

      timeout_reached:
        job.timeoutReached ??
        false,

      max_render_minutes:
        HARD_TIMEOUT_MINUTES,

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

      transition_mode:
        job.transitionMode ??
        null,

      render_width:
        job.renderWidth ??
        null,

      render_height:
        job.renderHeight ??
        null,

      render_fps:
        job.renderFps ??
        null,

      render_preset:
        job.renderPreset ??
        null,

      render_crf:
        job.renderCrf ??
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
        null

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

    const job =
      loadJob(
        req.params.jobId
      );


    if (!job) {

      return res
        .status(404)
        .json({
          error:
            'Job not found'
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
            'Video not ready',

          status:
            job.status,

          current_step:
            job.currentStep,

          detail:
            job.error

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
            'Video file missing'
        });

    }


    return res.download(
      job.outputPath,
      'final_video.mp4'
    );

  }
);


// ============================================================
// DEBUG
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
            'Job not found'
        });

    }


    return res.json(
      job
    );

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
      'N8N FFMPEG RENDER 4.1'
    );

    console.log(
      'Architecture: segment render + concat'
    );

    console.log(
      `Resolution: ${WIDTH}x${HEIGHT}`
    );

    console.log(
      `FPS: ${FPS}`
    );

    console.log(
      `Preset: ${PRESET}`
    );

    console.log(
      `CRF: ${CRF}`
    );

    console.log(
      `Fade: ${FADE_DURATION}s`
    );

    console.log(
      `Hard timeout: ${HARD_TIMEOUT_MINUTES}min`
    );

    console.log(
      '========================================'
    );

  }
);
