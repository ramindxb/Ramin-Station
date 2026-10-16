(() => {
  'use strict';
  const bridge = window.webkit?.messageHandlers?.raminStation;
  const requests = new Map(); let sequence = -1000;
  const previousResolve = window.raminNativeResolve;
  window.raminNativeResolve = (id,result) => {
    const request=requests.get(id);
    if (!request) return previousResolve?.(id,result);
    requests.delete(id); result?.error ? request.reject(new Error(result.error)) : request.resolve(result);
  };
  const request = (action,payload={}) => new Promise((resolve,reject) => {
    if (!bridge) return resolve({available:false,platform:'browser',currentVersion:'2.1.0',message:'Open the desktop app to check for and install updates.'});
    const id=--sequence;requests.set(id,{resolve,reject});bridge.postMessage({id,action,payload});
  });
  let state={available:false,currentVersion:'2.1.0'},installing=false,checking=false;
  const menuKey=document.createElement('button');menuKey.type='button';menuKey.className='station-file-key';menuKey.textContent='···';menuKey.setAttribute('aria-label','File menu');menuKey.setAttribute('aria-expanded','false');
  const menu=document.createElement('div');menu.className='station-update-menu';menu.hidden=true;
  const checkKey=document.createElement('button');checkKey.type='button';checkKey.textContent='Check for Updates…';menu.append(checkKey);
  const badge=document.createElement('button');badge.type='button';badge.className='station-update-notice';badge.hidden=true;badge.setAttribute('aria-label','Software update available');
  const dialog=document.createElement('dialog');dialog.className='station-update-dialog';dialog.setAttribute('aria-label','Software update');
  const heading=document.createElement('header');heading.textContent='RAMIN STATION / SOFTWARE UPDATE';
  const title=document.createElement('h2');title.textContent='Software update';
  const message=document.createElement('p');message.setAttribute('role','status');
  const notes=document.createElement('pre');notes.className='station-update-notes';
  const progress=document.createElement('progress');progress.max=100;progress.value=0;progress.hidden=true;progress.setAttribute('aria-label','Update download progress');
  const safety=document.createElement('small');safety.textContent='Your Visual Brain library stays in place. Its index is backed up before updating.';
  const actions=document.createElement('footer');
  const later=document.createElement('button');later.type='button';later.textContent='LATER';
  const install=document.createElement('button');install.type='button';install.className='is-primary';install.textContent='UPDATE & RESTART';install.hidden=true;
  actions.append(later,install);dialog.append(heading,title,message,notes,progress,safety,actions);document.body.append(menuKey,menu,badge,dialog);

  function render(){
    badge.hidden=!state.available;badge.textContent=state.available?`● UPDATE ${state.version} AVAILABLE`:'';
    menuKey.hidden=state.platform==='macos';
    if (installing) return;
    title.textContent=checking?'Checking for updates…':state.available?`Ramin Station ${state.version}`:'Ramin Station';
    message.textContent=checking?'Looking for a verified release…':state.available?`Installed: ${state.currentVersion}. A new version is ready to download.`:(state.message || 'No update is available.');
    notes.textContent=state.available?(state.notes||'A new version is available.') : `Installed version ${state.currentVersion}`;
    install.hidden=!state.available;install.disabled=checking;progress.hidden=true;
  }
  function open(){menu.hidden=true;menuKey.setAttribute('aria-expanded','false');render();if(!dialog.open)dialog.showModal();}
  async function check(){
    if(installing||checking)return;checking=true;open();
    try{state={...state,...await request('updateCheck')};}
    catch(error){message.textContent=error.message;state={...state,message:error.message};}
    finally{checking=false;render();}
  }
  window.stationUpdates={open:check};
  window.raminUpdateChanged = async event => {
    if (event.phase) {
      if (event.error) { installing=false;message.textContent=event.error;later.disabled=false;return; }
      message.textContent=event.message || 'Preparing update…';progress.hidden=false;progress.value=Number(event.progress)||0;
      if (event.phase==='ready') {
        message.textContent='Restarting to finish the update…';
        try{await request('updateRestart');}catch(error){message.textContent=error.message;installing=false;later.disabled=false;}
      }
      return;
    }
    state={...state,...event};render(); // Does not open a dialog during background checks.
  };
  menuKey.addEventListener('click',event=>{event.stopPropagation();menu.hidden=!menu.hidden;menuKey.setAttribute('aria-expanded',String(!menu.hidden));});
  document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target)&&event.target!==menuKey){menu.hidden=true;menuKey.setAttribute('aria-expanded','false');}});
  checkKey.addEventListener('click',check);badge.addEventListener('click',open);
  later.addEventListener('click',()=>{if(!installing)dialog.close();});
  dialog.addEventListener('cancel',event=>{if(installing)event.preventDefault();});
  install.addEventListener('click',async()=>{
    if(installing)return;
    try {
      if(typeof window.stationSaveBeforeUpdate==='function')await window.stationSaveBeforeUpdate();
      installing=true;install.disabled=true;later.disabled=true;progress.hidden=false;progress.value=0;message.textContent='Preparing your update…';
      await request('updateInstall');
    } catch(error){installing=false;install.disabled=false;later.disabled=false;message.textContent=error.message;}
  });
  request('updateStatus').then(result=>{state={...state,...result};render();}).catch(()=>{});
  if (bridge) request('updateAck').catch(()=>{});
  render();
})();
