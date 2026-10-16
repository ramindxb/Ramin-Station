// Local browser-preview backend. Native macOS/Windows use the same copy policy.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {spawn} = require('child_process');
const {StringDecoder} = require('string_decoder');
const probeArgs = ['-v','error','-show_streams','-show_format','-of','json'];

function runMedia(command, args, onLine = () => {}, signal) {
  return new Promise((resolve,reject) => {
    const child = spawn(command,args,{shell:false,signal});
    let output = '';
    const append = line => { output = (output + line + '\n').slice(-200000); onLine(line); };
    const consumeStream = stream => {
      const decoder = new StringDecoder('utf8'); let pending = '';
      stream.on('data',data => {
        pending += decoder.write(data);
        const lines = pending.split(/\r?\n/); pending = lines.pop() || ''; lines.forEach(append);
      });
      stream.on('end',() => { pending += decoder.end(); if (pending) append(pending); });
    };
    consumeStream(child.stdout); consumeStream(child.stderr);
    child.on('error',reject);
    child.on('close',code => {
      code === 0 ? resolve(output) : reject(new Error(output.slice(-900) || `${command} failed`));
    });
  });
}

async function preparePlayable(source, enabled = true, event = () => {}, signal, runner = runMedia) {
  const original = {path:source,name:path.basename(source),originalName:path.basename(source)};
  const unchanged = (compatibility,warning='') => { if (warning) event({message:warning}); return {...original,compatibility,warning}; };
  if (!enabled) return unchanged('disabled');
  event({message:'Checking playback compatibility…',progress:90});
  const probe = async file => JSON.parse(await runner('ffprobe',[...probeArgs,file],()=>{},signal));
  let info;
  try { info = await probe(source); if (!Array.isArray(info.streams)) throw new Error('Invalid probe'); }
  catch { return unchanged('unavailable','Original saved. Playback check needs FFmpeg + ffprobe; run Setup / Update.'); }
  const video = info.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = info.streams.filter(s => s.codec_type === 'audio');
  if (!video && !audio.length) return unchanged('original');
  const copyVideo = !video || video.codec_name === 'h264' && ['yuv420p','yuvj420p'].includes(video.pix_fmt);
  const copyAudio = audio.every(s => ['aac','mp3'].includes(s.codec_name));
  const containerOK = (video ? ['.mp4','.m4v','.mov'] : ['.mp3','.m4a','.mp4']).includes(path.extname(source).toLowerCase());
  if (copyVideo && copyAudio && containerOK) {
    event({message:'Already playable — original picture and sound unchanged.',progress:99}); return unchanged('original');
  }
  if (!copyVideo && (['smpte2084','arib-std-b67'].includes(video.color_transfer) || video.color_primaries === 'bt2020')) {
    return unchanged('needs-hdr','HDR original kept. Automatic SDR conversion is skipped to protect its colors.');
  }
  const duration = Number(info.format?.duration) || 0;
  const ext = video ? '.mp4' : '.m4a';
  const stem = path.parse(source).name.slice(0,150);
  let destination = path.join(path.dirname(source),`${stem} - Playable${ext}`);
  for (let i=2;fs.existsSync(destination);i++) destination = path.join(path.dirname(source),`${stem} - Playable ${i}${ext}`);
  const temporary = path.join(path.dirname(source),`.station-${crypto.randomUUID()}${ext}`);
  const args = ['-nostdin','-v','error','-n','-i',source,'-map','0:V:0?','-map','0:a?','-map_metadata','0','-map_chapters','0','-c:v','copy','-c:a','copy'];
  if (!copyVideo) args.push('-c:v','libx264','-preset','slow','-crf','14','-pix_fmt','yuv420p','-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-fps_mode','passthrough','-tag:v','avc1');
  audio.forEach((s,i) => { if (!['aac','mp3'].includes(s.codec_name)) args.push(`-c:a:${i}`,'aac',`-b:a:${i}`,'320k'); });
  const compatibility = copyVideo && copyAudio ? 'remux' : 'transcode';
  event({message:'Making a high-quality playable copy — original kept…',progress:90});
  args.push('-movflags','+faststart','-progress','pipe:1','-nostats',temporary);
  try {
    await runner('ffmpeg',args,line => {
      if (line.startsWith('out_time_us=') && duration) {
        const fraction = Math.max(0,Math.min(1,Number(line.split('=')[1])/1e6/duration));
        event({message:`Preparing playback ${Math.round(fraction*100)}%`,progress:90+fraction*9});
      }
    },signal);
    if (signal?.aborted) throw new Error('Cancelled');
    const check = await probe(temporary);
    if (check.streams.filter(s => s.codec_type === 'audio').length !== audio.length || (video && check.streams.filter(s => s.codec_type === 'video').length !== 1) || Math.abs(Number(check.format?.duration)-duration) >= Math.max(1,duration*.01)) throw new Error('Validation failed');
    fs.linkSync(temporary,destination); // Exclusive, never replace an existing file.
    event({message:compatibility === 'remux' ? 'Playable copy ready — picture and sound copied losslessly.' : copyAudio ? 'Playable copy ready — high-quality picture, original audio unchanged. Original kept.' : 'Playable copy ready — high-quality H.264/AAC. Original picture and sound kept in the source file.',progress:99});
    return {path:destination,name:path.basename(destination),originalName:path.basename(source),compatibility,warning:''};
  } catch {
    return unchanged(signal?.aborted ? 'cancelled' : 'failed', signal?.aborted ? 'Playable copy cancelled. Original kept.' : 'Original saved. Playable-copy conversion failed; the incomplete copy was discarded.');
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function managedMediaFile(root,storageID,name) {
  if (!/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(storageID || '') || !name || name.startsWith('.') || path.basename(name)!==name || /[\\/]/.test(name)) throw new Error('Invalid managed media path.');
  const file = path.join(root,storageID,name);
  if (fs.realpathSync(file)!==file || !fs.statSync(file).isFile()) throw new Error('Unsafe managed media path.');
  return file;
}

function serveMedia(req,res,file) {
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  const size = fs.statSync(file).size;
  let start=0,end=size-1,partial=false;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || !match[1] && !match[2]) { res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return; }
    if (!match[1]) start=Math.max(0,size-Number(match[2]));
    else { start=Number(match[1]); if (match[2]) end=Math.min(end,Number(match[2])); }
    if (start<0 || start>=size || end<start) { res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return; }
    partial=true;
  }
  const mime = {'.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mp3':'audio/mpeg','.m4a':'audio/mp4','.wav':'audio/wav','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'}[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(partial?206:200,{'Content-Type':mime,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store',...(partial?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
  if (req.method==='HEAD') { res.end();return; }
  const stream=fs.createReadStream(file,{start,end}); stream.on('error',()=>res.destroy()); res.on('close',()=>stream.destroy()); stream.pipe(res);
}

module.exports = {preparePlayable,runMedia,managedMediaFile,serveMedia,probeArgs};
