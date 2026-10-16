// Offline release signing. Private keys must never be uploaded or committed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [command,...args] = process.argv.slice(2);

if (command === 'keygen') {
  const directory=path.resolve(args[0] || '');
  if (!args[0]) throw new Error('Specify a private directory outside the Git repository.');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Key directory cannot be a symlink.');
  const file=path.join(directory,'station-update-private.pem');
  if (fs.existsSync(file)) throw new Error('A signing key already exists. It was not replaced.');
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(file,privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
  const raw=Buffer.from(publicKey.export({format:'jwk'}).x,'base64url').toString('base64');
  fs.writeFileSync(path.join(directory,'station-update-public.txt'),raw+'\n',{flag:'wx',mode:0o644});
  console.log(JSON.stringify({publicKey:raw,privateKeyFile:file}));
} else if (command === 'sign') {
  const [configPath,distPath,notesPath,keyPath]=args;
  if (!keyPath) throw new Error('Usage: sign config.json dist notes.txt private-key.pem');
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  const privateKey=crypto.createPrivateKey(fs.readFileSync(keyPath));
  const raw=Buffer.from(crypto.createPublicKey(privateKey).export({format:'jwk'}).x,'base64url').toString('base64');
  if (raw!==config.publicKey) throw new Error('Signing key does not match the key pinned inside the app.');
  const packages={};
  for (const [platform,suffix] of [['macos','macOS.zip'],['windows','Windows-Portable.zip']]) {
    const name=`Ramin-Station-${config.version}-${suffix}`;
    const file=path.join(distPath,name),info=fs.statSync(file);
    if (!info.isFile() || info.size<1 || info.size>512*1024*1024) throw new Error('Invalid release package: '+name);
    packages[platform]={url:`https://github.com/ramindxb/Ramin-Station/releases/download/v${config.version}/${name}`,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),size:info.size};
  }
  const now=new Date();
  const manifest={schema:1,product:config.product,channel:config.channel,version:config.version,build:config.build,notes:fs.readFileSync(notesPath,'utf8').slice(0,12000),published:now.toISOString(),expires:new Date(now.getTime()+365*86400000).toISOString(),packages};
  const payload=Buffer.from(JSON.stringify(manifest));
  const envelope={payload:payload.toString('base64'),signature:crypto.sign(null,payload,privateKey).toString('base64')};
  const output=path.join(distPath,'updates-stable.json');
  fs.writeFileSync(output,JSON.stringify(envelope,null,2)+'\n');console.log(output);
} else throw new Error('Use keygen or sign.');
