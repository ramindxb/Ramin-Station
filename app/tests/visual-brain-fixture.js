(() => {
  const makeFile = (id, title, category, name) => ({id, title, category, name, type:'file', storageID:id, mime:'video/mp4', note:'A reminder for the next creative session.', hashtags:'#client #campaign'});
  const sample = {version:2, items:[
    makeFile('portrait', 'Morning inspiration', 'motivation', 'portrait.mp4'),
    makeFile('landscape', 'Keep creating', 'motivation', 'landscape.mp4'),
    makeFile('idea', 'Color & motion study', 'instagram', 'landscape.mp4'),
    {id:'link', title:'A reference for the next edit', category:'youtube', type:'link', url:'https://example.com/reference', note:'Save the idea, not just the link.', hashtags:'#studio'}
  ]};
  const respond = message => {
    let result = {ok:true};
    if (message.action === 'visualBrainLoad') result = {state:sample};
    if (message.action === 'visualBrainMediaURL') result = {url:`/tests/fixtures/${message.payload.name}`};
    if (message.action === 'updateStatus') result = {available:false,currentVersion:'2.1.0',platform:'macos'};
    queueMicrotask(() => window.raminNativeResolve(message.id, result));
  };
  window.webkit = {messageHandlers:{raminStation:{postMessage:respond}}};
})();
