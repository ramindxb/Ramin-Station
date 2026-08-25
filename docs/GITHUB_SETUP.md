# GitHub repository setup

1. Create an empty repository named `Ramin-Station` under the `ramindxb` account. Do not add a README, license, or `.gitignore` on GitHub because this folder already contains them.
2. From this folder, add the remote and push:

   ```bash
   git remote add origin https://github.com/ramindxb/Ramin-Station.git
   git push -u origin main
   ```

3. In **Settings → General → Social preview**, upload `docs/social-preview.png`.
4. Add repository topics such as `ffmpeg`, `yt-dlp`, `macos`, `windows`, `video-compression`, and `media-downloader`.
5. Enable Issues if you want public bug reports.
6. Publish V1 by pushing the prepared tag:

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

The Release workflow will compile the packages and publish them automatically. Alternatively, create a GitHub Release manually and upload the files from the local `release-assets/` folder.
