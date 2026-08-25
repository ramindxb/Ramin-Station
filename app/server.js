const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const appDir = __dirname;
const port = 3186;
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png'};

function commandInfo(command, args) {
  const result = spawnSync(command, args, {encoding:'utf8'});
  const line = `${result.stdout || ''}${result.stderr || ''}`.split('\n')[0].trim();
  return { ready: result.status === 0, version: line.slice(0, 42) };
}

function dependencies() {
  return { ffmpeg: commandInfo('ffmpeg', ['-version']), ytdlp: commandInfo('yt-dlp', ['--version']) };
}

function json(res, status, body) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (error) { reject(error); } });
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {shell:false});
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(output.slice(-500) || `${command} failed`)));
  });
}

async function installTools(names) {
  const wanted = names.filter(name => ['ffmpeg','ytdlp'].includes(name));
  for (const name of wanted) {
    if (dependencies()[name].ready) continue;
    if (process.platform === 'darwin') {
      const packageName = name === 'ytdlp' ? 'yt-dlp' : 'ffmpeg';
      await run('brew', ['install', packageName]);
    } else if (process.platform === 'win32') {
      const packageId = name === 'ytdlp' ? 'yt-dlp.yt-dlp' : 'Gyan.FFmpeg';
      await run('winget', ['install','--id',packageId,'--exact','--accept-package-agreements','--accept-source-agreements']);
    } else {
      throw new Error('Automatic setup currently supports macOS and Windows.');
    }
  }
  return dependencies();
}

async function downloadMedia(payload) {
  if (!/^https?:\/\//i.test(payload.url || '')) throw new Error('Enter a valid http(s) URL.');
  const outDir = path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(outDir, {recursive:true});
  const args = ['--no-playlist','--retries','5','--fragment-retries','5','-o',path.join(outDir,'%(title)s.%(ext)s')];
  if (['chrome','safari','edge','firefox'].includes(payload.cookies)) args.push('--cookies-from-browser',payload.cookies);
  if (payload.cookies === 'cookiefile' && payload.cookieFile) args.push('--cookies',payload.cookieFile);
  if (payload.mediaType === 'audio') {
    args.push('-x','--audio-format','mp3','--audio-quality', payload.quality === '128' ? '128K' : payload.quality === '256' ? '256K' : '0');
  } else {
    const height = ['1080','720','480'].includes(payload.quality) ? payload.quality : '1080';
    args.push('-f',`bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`,'--merge-output-format','mp4');
  }
  args.push(payload.url);
  await run('yt-dlp', args);
  return {message:'download complete', folder:outDir};
}

async function compressFolder(payload) {
  const source = path.resolve(payload.source || payload.folder || '');
  const stat = fs.existsSync(source) && fs.statSync(source);
  if (!stat) throw new Error('Choose a valid source file or folder.');
  const folder = stat.isDirectory() ? source : path.dirname(source);
  const allowed = payload.inputType === 'all' ? ['.mp4','.mov','.mkv','.avi','.m4v','.webm'] : [`.${payload.inputType}`];
  const files = stat.isDirectory()
    ? fs.readdirSync(folder).filter(file => allowed.includes(path.extname(file).toLowerCase())).map(file => path.join(folder,file))
    : [source];
  if (!files.length) throw new Error('No matching video files found.');
  const settings = {high:{crf:'21',audio:'192k'},balanced:{crf:'26',audio:'128k'},tiny:{crf:'31',audio:'96k'}}[payload.quality] || {crf:'26',audio:'128k'};
  const editReady = payload.processMode === 'decompress';
  const outDir = path.join(folder, editReady ? 'Ramin Station Edit' : 'Ramin Station HEVC');
  fs.mkdirSync(outDir, {recursive:true});
  for (const file of files) {
    const output = path.join(outDir,`${path.parse(file).name}${editReady ? '_EDIT.mov' : '_HEVC.mp4'}`);
    const codec = editReady
      ? ['-c:v','prores_ks','-profile:v','0','-pix_fmt','yuv422p10le','-c:a','pcm_s16le']
      : ['-c:v','libx265','-preset','slow','-crf',settings.crf,'-tag:v','hvc1','-c:a','aac','-b:a',settings.audio];
    await run('ffmpeg',['-y','-i',file,...codec,output]);
  }
  return {message:editReady ? `${files.length} edit-ready file(s) created` : `${files.length} file(s) compressed`, folder:outDir};
}

const server = http.createServer(async (req,res) => {
  try {
    if (req.url === '/api/dependencies' && req.method === 'GET') return json(res,200,dependencies());
    if (req.url === '/api/install' && req.method === 'POST') return json(res,200,await installTools((await readBody(req)).tools || []));
    if (req.url === '/api/download' && req.method === 'POST') return json(res,200,await downloadMedia(await readBody(req)));
    if (req.url === '/api/compress' && req.method === 'POST') return json(res,200,await compressFolder(await readBody(req)));
    const clean = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
    const file = path.normalize(path.join(appDir, clean));
    if (!file.startsWith(appDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res,404,{error:'Not found'});
    res.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    json(res,400,{error:error.message || 'Operation failed'});
  }
});

server.listen(port,'127.0.0.1',() => console.log(`Ramin Station running at http://127.0.0.1:${port}`));
