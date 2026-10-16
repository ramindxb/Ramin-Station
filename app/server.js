const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const {preparePlayable,runMedia,managedMediaFile,serveMedia} = require('./playback');

const appDir = __dirname;
const port = Number(process.env.RAMIN_STATION_PORT) || 3186;
let activeJob;
async function withJob(operation) {
  if (activeJob) throw new Error('Another media job is running. Finish or cancel it first.');
  const controller = new AbortController(); activeJob = controller;
  try { return await operation(controller.signal); } finally { if (activeJob===controller) activeJob=undefined; }
}
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png'};

function commandInfo(command, args) {
  const result = spawnSync(command, args, {encoding:'utf8'});
  const line = `${result.stdout || ''}${result.stderr || ''}`.split('\n')[0].trim();
  return { ready: result.status === 0, version: line.slice(0, 42) };
}

function dependencies() {
  const ffmpeg=commandInfo('ffmpeg',['-version']);
  if (!commandInfo('ffprobe',['-version']).ready) { ffmpeg.ready=false;ffmpeg.version='ffprobe missing — run setup'; }
  return {ffmpeg,ytdlp:commandInfo('yt-dlp',['--version']),deno:commandInfo('deno',['--version'])};
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

async function downloadMedia(payload, event = () => {}, signal, directory) {
  if (!/^https?:\/\//i.test(payload.url || '')) throw new Error('Enter a valid http(s) URL.');
  const outDir = directory || process.env.RAMIN_STATION_DOWNLOADS || path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(outDir, {recursive:true});
  const args = ['--no-playlist','--no-simulate','--no-overwrites','--newline','--retries','5','--fragment-retries','5','--print','after_move:RS_FILE:%(filepath)j','--progress-template','download:RS_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s','-o',path.join(outDir,'%(title).150B [%(id)s].%(ext)s')];
  if (payload.mediaType === 'audio') {
    args.push('-x','--audio-format','mp3','--audio-quality', payload.quality === '128' ? '128K' : payload.quality === '256' ? '256K' : '0');
  } else {
    const height = ['1080','720','480'].includes(payload.quality) ? payload.quality : '1080';
    args.push('-f',`bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`,'--merge-output-format','mp4');
  }
  args.push('--progress');
  const attempts = [[]];
  if (['chrome','safari','edge','firefox'].includes(payload.cookies)) attempts.push(['--cookies-from-browser',payload.cookies]);
  if (payload.cookies === 'cookiefile' && payload.cookieFile) attempts.push(['--cookies',payload.cookieFile]);
  if (payload.cookies === 'auto') for (const browser of process.platform==='darwin'?['chrome','safari','firefox']:['chrome','edge','firefox']) attempts.push(['--cookies-from-browser',browser]);
  let lastError, output;
  for (const auth of attempts) {
    if (signal?.aborted) throw new Error('Operation cancelled.');
    try {
      output = await runMedia('yt-dlp',[...args,...auth,payload.url],line => {
        const match=line.match(/RS_PROGRESS:\s*([\d.]+)%?/);
        if (match) event({progress:Number(match[1])*(payload.autoPlayable===false?1:.9),message:`Downloading ${Math.round(Number(match[1]))}%`});
      },signal); lastError=undefined; break;
    } catch (error) { lastError=error; if (!/cookies|login|sign in|bot|403|po token/i.test(error.message)) break; }
  }
  if (lastError) throw lastError;
  const marker=output.split(/\r?\n/).filter(line=>line.startsWith('RS_FILE:')).pop();
  const original=marker && JSON.parse(marker.slice(8));
  if (!original || path.dirname(path.resolve(original))!==path.resolve(outDir) || fs.realpathSync(original)!==path.resolve(original)) throw new Error('Download saved, but its final filename could not be verified. Run Setup / Update.');
  const result=await preparePlayable(original,payload.autoPlayable!==false,event,signal);
  return {...result,message:result.warning?'Downloaded — playback needs attention':'Download complete',folder:outDir};
}

function visualBrainMediaRoot() {
  if (process.env.RAMIN_STATION_MEDIA_ROOT) return path.resolve(process.env.RAMIN_STATION_MEDIA_ROOT);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Ramin Station', 'Visual Brain Files');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Ramin Station', 'Visual Brain Files');
  return path.join(os.homedir(), '.local', 'share', 'Ramin Station', 'Visual Brain Files');
}

async function streamVisualBrainDownload(payload, res, signal) {
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
    send({progress:1, message:'Reading media info…'});
    const result = await downloadMedia(payload,send,signal,itemDir);
    const name = result.name;
    if (!name) throw new Error('The download finished without a saved file.');
    const extension = path.extname(name).toLowerCase();
    const mediaMime = {'.mp4':'video/mp4','.mov':'video/quicktime','.mkv':'video/x-matroska','.webm':'video/webm','.mp3':'audio/mpeg','.m4a':'audio/mp4','.wav':'audio/wav','.ogg':'audio/ogg'}[extension] || 'application/octet-stream';
    send({progress:100, message:'Saved to Visual Brain'});
    send({complete:{...result,storageID:payload.storageID,name,title:path.parse(name).name,mime:mediaMime}});
  } catch (error) {
    if (itemDir && fs.existsSync(itemDir) && !fs.readdirSync(itemDir).some(name=>!name.startsWith('.')&&!/\.(part|ytdl)$/.test(name))) fs.rmSync(itemDir, {recursive:true, force:true});
    send({error:error.message || 'Background download failed.'});
  } finally {
    res.end();
  }
}

async function compressFolder(payload, signal) {
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
    await runMedia('ffmpeg',['-nostdin','-y','-i',file,...codec,output],()=>{},signal);
  }
  return {message:editReady ? `${files.length} edit-ready file(s) created` : `${files.length} file(s) compressed`, folder:outDir};
}

const server = http.createServer(async (req,res) => {
  try {
    // Do not allow an unrelated website to trigger local downloads/conversions.
    if (req.method==='POST' && (req.headers.origin && req.headers.origin!==`http://127.0.0.1:${port}` || !String(req.headers['content-type']).startsWith('application/json'))) return json(res,403,{error:'Local application requests only.'});
    if (req.url === '/api/dependencies' && req.method === 'GET') return json(res,200,dependencies());
    if (req.url === '/api/install' && req.method === 'POST') return json(res,200,await installTools((await readBody(req)).tools || []));
    if (req.url === '/api/cancel' && req.method === 'POST') { activeJob?.abort(); return json(res,200,{message:'Cancel requested'}); }
    if (req.url === '/api/download' && req.method === 'POST') {
      const payload=await readBody(req);
      if (activeJob) throw new Error('Another media job is running.');
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store'});
      const send=event=>res.write(`${JSON.stringify(event)}\n`);
      try { send({complete:await withJob(signal=>downloadMedia(payload,send,signal))}); }
      catch(error) { send({error:error.message}); }
      res.end(); return;
    }
    if (req.url === '/api/visual-brain-download' && req.method === 'POST') {
      const payload = await readBody(req);
      if (activeJob) throw new Error('Another media job is running.');
      res.writeHead(200, {'Content-Type':'application/x-ndjson; charset=utf-8', 'Cache-Control':'no-store'});
      return await withJob(signal=>streamVisualBrainDownload(payload, res, signal));
    }
    if (req.url === '/api/visual-brain-playable' && req.method === 'POST') {
      const payload=await readBody(req);
      const file=managedMediaFile(visualBrainMediaRoot(),payload.storageID,payload.name);
      return json(res,200,await withJob(signal=>preparePlayable(file,true,()=>{},signal)));
    }
    if (req.url.startsWith('/api/visual-brain-media/')) {
      const parts=req.url.split('?')[0].split('/').slice(3).map(decodeURIComponent);
      if (parts.length!==2) throw new Error('Invalid media path.');
      return serveMedia(req,res,managedMediaFile(visualBrainMediaRoot(),parts[0],parts[1]));
    }
    if (req.url === '/api/compress' && req.method === 'POST') {
      const payload=await readBody(req);
      return json(res,200,await withJob(signal=>compressFolder(payload,signal)));
    }
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
