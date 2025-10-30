const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());

app.post('/api/merge-videos', upload.fields([
  { name: 'intro', maxCount: 1 },
  { name: 'main', maxCount: 1 }
]), async (req, res) => {
  let introPath, mainPath, fileListPath, outputPath;
  try {
    introPath = req.files.intro[0].path;
    mainPath = req.files.main[0].path;
    outputPath = path.join('uploads', `merged_${Date.now()}.mp4`);
    fileListPath = path.join('uploads', `filelist_${Date.now()}.txt`);

    const fileList = `file '${path.resolve(introPath)}'
file '${path.resolve(mainPath)}'`;
    fs.writeFileSync(fileListPath, fileList);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(fileListPath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    res.sendFile(path.resolve(outputPath), () => {
      try {
        fs.unlinkSync(introPath);
        fs.unlinkSync(mainPath);
        fs.unlinkSync(fileListPath);
        fs.unlinkSync(outputPath);
      } catch (e) {}
    });
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));