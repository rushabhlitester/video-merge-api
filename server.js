const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');

const app = express();

// Use OS temp directory for better file handling on Render
const TMP = path.join(os.tmpdir(), 'video-merge-api');
fs.mkdirSync(TMP, { recursive: true });

const upload = multer({ dest: TMP });

app.use(cors());

// Helper to log
function log(...args) {
  console.log('[merge]', ...args);
}

app.post('/api/merge-videos', upload.fields([
  { name: 'intro', maxCount: 1 },
  { name: 'main', maxCount: 1 }
]), async (req, res) => {
  let introPath, mainPath, outputPath;
  try {
    if (!req.files || !req.files.intro || !req.files.main) {
      return res.status(400).json({ error: 'Missing files. Send form fields "intro" and "main".' });
    }

    introPath = req.files.intro[0].path;
    mainPath = req.files.main[0].path;
    outputPath = path.join(TMP, `merged_${Date.now()}.mp4`);

    // Probe both files to detect audio streams
    const probeIntro = new Promise((resolve, reject) => {
      ffmpeg.ffprobe(introPath, (err, info) => err ? reject(err) : resolve(info));
    });
    const probeMain = new Promise((resolve, reject) => {
      ffmpeg.ffprobe(mainPath, (err, info) => err ? reject(err) : resolve(info));
    });

    const [introInfo, mainInfo] = await Promise.all([probeIntro, probeMain]);

    // Check for audio streams
    const introHasA = (introInfo?.streams || []).some(s => s.codec_type === 'audio');
    const mainHasA = (mainInfo?.streams || []).some(s => s.codec_type === 'audio');

    log('intro audio:', introHasA ? 'yes' : 'no');
    log('main audio:', mainHasA ? 'yes' : 'no');

    // Build the complex filter chain
    // Video: normalize fps, pixel format, reset timestamps
    const videoFilters = [
      '[0:v]fps=30,format=yuv420p,scale=w=1920:h=1080:force_original_aspect_ratio=decrease,setpts=PTS-STARTPTS[v0]',
      '[1:v]fps=30,format=yuv420p,scale=w=1920:h=1080:force_original_aspect_ratio=decrease,setpts=PTS-STARTPTS[v1]'
    ];

    // Audio: handle based on presence in inputs
    const audioFilters = [];
    let concatFilter;
    let hasAudioOutput = false;

    if (introHasA && mainHasA) {
      // Both have audio: resample both and concat
      audioFilters.push('[0:a]aresample=48000,asetpts=PTS-STARTPTS[a0]');
      audioFilters.push('[1:a]aresample=48000,asetpts=PTS-STARTPTS[a1]');
      concatFilter = '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]';
      hasAudioOutput = true;
      log('audio strategy: both inputs have audio - concatenating');
    } else if (introHasA && !mainHasA) {
      // Only intro has audio: use intro audio for the whole output
      audioFilters.push('[0:a]aresample=48000,asetpts=PTS-STARTPTS[a0]');
      concatFilter = '[v0][a0][v1][a0]concat=n=2:v=1:a=1[v][a]';
      hasAudioOutput = true;
      log('audio strategy: only intro has audio - extending through concat');
    } else if (!introHasA && mainHasA) {
      // Only main has audio: concat video only, then overlay audio from main
      concatFilter = '[v0][v1]concat=n=2:v=1:a=0[v]';
      audioFilters.push('[1:a]aresample=48000,asetpts=PTS-STARTPTS[a1]');
      hasAudioOutput = true;
      log('audio strategy: only main has audio - using main audio track');
    } else {
      // Neither has audio: concat video only
      concatFilter = '[v0][v1]concat=n=2:v=1:a=0[v]';
      hasAudioOutput = false;
      log('audio strategy: no audio in either input');
    }

    const allFilters = [...videoFilters, ...audioFilters, concatFilter];

    log('merge filters:', allFilters.length, 'rules applied');

    // Execute the merge with robust error handling
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg()
        .input(introPath)
        .input(mainPath)
        .complexFilter(allFilters);

      // Map outputs based on audio presence
      if (hasAudioOutput) {
        cmd.outputOptions([
          '-map [v]',
          '-map [a]',
          '-c:v libx264',
          '-preset veryfast',
          '-crf 20',
          '-c:a aac',
          '-b:a 192k',
          '-movflags +faststart'
        ]);
      } else {
        cmd.outputOptions([
          '-map [v]',
          '-c:v libx264',
          '-preset veryfast',
          '-crf 20',
          '-movflags +faststart'
        ]);
      }

      cmd
        .on('end', () => {
          log('merge complete');
          resolve();
        })
        .on('error', (err) => {
          log('merge error:', err.message);
          reject(err);
        })
        .save(outputPath);
    });

    // Send the merged file
    res.sendFile(path.resolve(outputPath), (err) => {
      // Clean up temp files after response finishes
      setImmediate(() => {
        try {
          fs.unlinkSync(introPath);
          fs.unlinkSync(mainPath);
          fs.unlinkSync(outputPath);
          log('temp files cleaned up');
        } catch (e) {
          log('cleanup warning:', e.message);
        }
      });
    });
  } catch (error) {
    log('error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
  log('temp dir:', TMP);
});

module.exports = app;