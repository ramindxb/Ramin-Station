const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {preparePlayable,managedMediaFile} = require('../playback');

function fixture(t, video='vp9', audio='aac', ext='.mp4', extra={}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'station-playback-test-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source = path.join(root,`original${ext}`); fs.writeFileSync(source,'original bytes');
  const info = {streams:[...(video?[{codec_type:'video',codec_name:video,pix_fmt:'yuv420p',...extra}]:[]),...(audio?[{codec_type:'audio',codec_name:audio}]:[])],format:{duration:'1'}};
  let args, fail=false, cancelled=false;
  const runner = async(command,arguments_) => {
    if (command==='ffprobe') {
      if (arguments_.at(-1)===source) return JSON.stringify(info);
      return JSON.stringify({...info,streams:info.streams.map(s=>({...s,codec_name:s.codec_type==='video'?'h264':'aac'}))});
    }
    args=arguments_; fs.writeFileSync(arguments_.at(-1),'playable bytes');
    if (fail) throw new Error('disk full');
    return '';
  };
  return {root,source,info,runner,get args(){return args},set fail(v){fail=v},set cancelled(v){cancelled=v},cancel:()=>cancelled};
}

test('compatible H.264/AAC stays byte-for-byte unchanged',async t=>{
  const f=fixture(t,'h264');const r=await preparePlayable(f.source,true,()=>{},undefined,f.runner);
  assert.equal(r.path,f.source);assert.equal(r.compatibility,'original');assert.equal(f.args,undefined);assert.equal(fs.readFileSync(f.source,'utf8'),'original bytes');
});
test('disabled skips inspection entirely',async t=>{
  const f=fixture(t);const r=await preparePlayable(f.source,false,()=>{},undefined,()=>{throw new Error('must not run')});
  assert.equal(r.compatibility,'disabled');assert.equal(r.path,f.source);
});
test('container repair uses stream copy, not an encoder',async t=>{
  const f=fixture(t,'h264','aac','.mkv');const r=await preparePlayable(f.source,true,()=>{},undefined,f.runner);
  assert.equal(r.compatibility,'remux');assert.ok(!f.args.includes('libx264'));assert.ok(!f.args.includes('320k'));assert.ok(fs.existsSync(f.source));
});
test('VP9 gets a high-quality second file with unchanged AAC',async t=>{
  const f=fixture(t);const r=await preparePlayable(f.source,true,()=>{},undefined,f.runner);
  assert.equal(r.compatibility,'transcode');assert.notEqual(r.path,f.source);assert.ok(f.args.includes('libx264'));assert.ok(f.args.includes('14'));assert.ok(!f.args.includes('320k'));assert.ok(!f.args.includes('-r'));assert.equal(fs.readFileSync(f.source,'utf8'),'original bytes');
});
test('unsupported audio is explicitly converted, not falsely called lossless',async t=>{
  const f=fixture(t,'h264','opus','.mkv');const r=await preparePlayable(f.source,true,()=>{},undefined,f.runner);
  assert.equal(r.compatibility,'transcode');assert.ok(f.args.includes('-c:a:0'));assert.ok(f.args.includes('320k'));assert.ok(!f.args.includes('libx264'));
});
test('HDR is preserved instead of silently flattened',async t=>{
  const f=fixture(t,'vp9','aac','.mp4',{color_transfer:'smpte2084',color_primaries:'bt2020'});const r=await preparePlayable(f.source,true,()=>{},undefined,f.runner);
  assert.equal(r.compatibility,'needs-hdr');assert.ok(r.warning);assert.equal(f.args,undefined);
});
test('failed conversion removes only temporary output',async t=>{
  const f=fixture(t);f.fail=true;const r=await preparePlayable(f.source,true,()=>{},undefined,f.runner);
  assert.equal(r.compatibility,'failed');assert.deepEqual(fs.readdirSync(f.root),['original.mp4']);assert.equal(fs.readFileSync(f.source,'utf8'),'original bytes');
});
test('missing tools keep the downloaded original and return a warning',async t=>{
  const f=fixture(t);const r=await preparePlayable(f.source,true,()=>{},undefined,()=>{throw new Error('ENOENT')});
  assert.equal(r.compatibility,'unavailable');assert.equal(r.path,f.source);assert.ok(r.warning);
});
test('existing playable filename is not overwritten',async t=>{
  const f=fixture(t);const existing=path.join(f.root,'original - Playable.mp4');fs.writeFileSync(existing,'existing copy');
  const r=await preparePlayable(f.source,true,()=>{},undefined,f.runner);
  assert.equal(path.basename(r.path),'original - Playable 2.mp4');assert.equal(fs.readFileSync(existing,'utf8'),'existing copy');
});
test('cancellation discards the partial copy and preserves the original',async t=>{
  const f=fixture(t),controller=new AbortController();
  const runner=async(command,args,...rest)=>{const output=await f.runner(command,args,...rest);if(command==='ffmpeg')controller.abort();return output};
  const r=await preparePlayable(f.source,true,()=>{},controller.signal,runner);
  assert.equal(r.compatibility,'cancelled');assert.deepEqual(fs.readdirSync(f.root),['original.mp4']);assert.equal(fs.readFileSync(f.source,'utf8'),'original bytes');
});
test('managed media rejects traversal, hidden files and symlinks',t=>{
  const f=fixture(t),id='8d54f620-d630-4214-915f-2e081bedde57',directory=path.join(f.root,id);fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'clip.mp4'),'clip');
  assert.equal(managedMediaFile(f.root,id,'clip.mp4'),path.join(directory,'clip.mp4'));
  assert.throws(()=>managedMediaFile(f.root,id,'../original.mp4'));assert.throws(()=>managedMediaFile(f.root,id,'.station-part.mp4'));assert.throws(()=>managedMediaFile(f.root,'../','clip.mp4'));
  fs.symlinkSync(f.source,path.join(directory,'link.mp4'));assert.throws(()=>managedMediaFile(f.root,id,'link.mp4'));
});
