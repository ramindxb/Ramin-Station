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

function visualBrainMediaRoot() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Ramin Station', 'Visual Brain Files');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Ramin Station', 'Visual Brain Files');
  return path.join(os.homedir(), '.local', 'share', 'Ramin Station', 'Visual Brain Files');
}

function runDownloadStream(args, onEvent) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, {shell:false});
    let output = '';
    let pending = '';
    const consume = chunk => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-120000);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      lines.forEach(line => {
        const match = line.match(/RS_PROGRESS:\s*([\d.]+)%?\|([^|]*)\|([^|]*)/);
        if (match) onEvent({progress:Number(match[1]) || 0, message:`Downloading ${Math.round(Number(match[1]) || 0)}%`});
        else if (/^\[(Merger|ExtractAudio)\]/.test(line.trim())) onEvent({progress:100, message:'Processing media…'});
      });
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(output.slice(-900) || 'yt-dlp failed')));
  });
}

async function streamVisualBrainDownload(payload, res) {
  const send = event => res.write(`${JSON.stringify(event)}\n`);
  let itemDir = '';
  try {
    if (!/^https?:\/\//i.test(payload.url || '')) throw new Error('Enter a valid http(s) URL.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.storageID || '')) throw new Error('Invalid Visual Brain storage ID.');
    if (!commandInfo('yt-dlp', ['--version']).ready) throw new Error('yt-dlp is not installed. Use Setup / Update first.');
    const root = visualBrainMediaRoot();
    fs.mkdirSync(root, {recursive:true});
    itemDir = path.join(root, payload.storageID);
    if (fs.existsSync(itemDir)) throw new Error('This Visual Brain download already exists.');
    fs.mkdirSync(itemDir);
    const base = ['--no-playlist','--newline','--retries','5','--fragment-retries','5','--progress-template','download:RS_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s','-o',path.join(itemDir,'%(title)s.%(ext)s')];
    if (payload.mediaType === 'audio') base.push('-x','--audio-format','mp3','--audio-quality','0');
    else base.push('-f','bestvideo[height<=1080]+bestaudio/best[height<=1080]/best','--merge-output-format','mp4');
    const attempts = payload.cookies === 'auto'
      ? [[], ['--cookies-from-browser','chrome'], ['--cookies-from-browser','safari'], ['--cookies-from-browser','firefox']]
      : [];
    if (['chrome','safari','edge','firefox'].includes(payload.cookies)) attempts.push(['--cookies-from-browser',payload.cookies]);
    if (!attempts.length) attempts.push([]);
    send({progress:1, message:'Reading media info…'});
    let finalError;
    for (const auth of attempts) {
      try {
        await runDownloadStream([...base, ...auth, payload.url], send);
        finalError = null;
        break;
      } catch (error) {
        finalError = error;
      }
    }
    if (finalError) throw finalError;
    const name = fs.readdirSync(itemDir).find(file => !file.startsWith('.') && !file.endsWith('.part') && fs.statSync(path.join(itemDir,file)).isFile());
    if (!name) throw new Error('The download finished without a saved file.');
    const extension = path.extname(name).toLowerCase();
    const mediaMime = {'.mp4':'video/mp4','.mov':'video/quicktime','.mkv':'video/x-matroska','.webm':'video/webm','.mp3':'audio/mpeg','.m4a':'audio/mp4','.wav':'audio/wav','.ogg':'audio/ogg'}[extension] || 'application/octet-stream';
    send({progress:100, message:'Saved to Visual Brain'});
    send({complete:{storageID:payload.storageID,name,title:path.parse(name).name,mime:mediaMime}});
  } catch (error) {
    if (itemDir && fs.existsSync(itemDir)) fs.rmSync(itemDir, {recursive:true, force:true});
    send({error:error.message || 'Background download failed.'});
  } finally {
    res.end();
  }
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
    if (req.url === '/api/visual-brain-download' && req.method === 'POST') {
      const payload = await readBody(req);
      res.writeHead(200, {'Content-Type':'application/x-ndjson; charset=utf-8', 'Cache-Control':'no-store'});
      return streamVisualBrainDownload(payload, res);
    }
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
