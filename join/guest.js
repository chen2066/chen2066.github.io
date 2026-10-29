/*
 * Darkest Reflex standalone P2 WebRTC guest.
 * Client-only implementation; no relay endpoints, cookies, account or billing.
 * Wire protocol: two gzip/base64 JSON SDP + ICE pieces separated by ';'.
 */
const $ = id => document.getElementById(id);
const ko = navigator.language.toLowerCase().startsWith("ko");
const params = new URLSearchParams(location.search);
const session = params.get("session") || "";
const mode = params.get("manual");
const STUN_ONLY = [{urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"]}];
const MAX_CODE_LENGTH = 132000;
let peer = null;
let mediaPeer = null;
// Independent Pion H.264 receiver. Never changes the controller or game-audio peer.
let gpuPeer = null;
let gpuVideoTrack = null;
let fallbackVideoTrack = null;
let gpuStatsTimer = null;
let gpuConnectTimeout = null;
let gpuEpoch = 0;
let pendingGpuCandidates = [];
let keyboard = null;
let mouse = null;
let streamSignal = null;
let heartbeat = null;
let streamRequest = null;
let negotiationDone = false;
let mediaStage = '';
let lastMediaNotice = '';
let active = false;
let busy = false;
let pendingMediaCandidates = [];
const heldKeys = new Set();
const media = new MediaStream();
const video = $("stream-video");
const gameAudio=document.createElement('audio');
gameAudio.preload='none';gameAudio.volume=1;
let remoteAudioTrack=false, audioPackets=0,audioStatTimer;
function audioState(){
 const tracks=gameAudio.srcObject instanceof MediaStream?gameAudio.srcObject.getAudioTracks():[];
 $("audioStatus").textContent=!tracks.length?(ko?'오디오 트랙 미도착':'Audio track missing'):
   gameAudio.paused?(ko?'소리 재생 대기':'Audio playback paused'):(ko?'소리 재생 중':'Audio playing');
}
let fpsSince=0,lastPresented=0,fpsActive=false;
let actualDisplayedFps=0,actualDecodedFps=0;
// Video recovery never closes P2 keyboard/mouse. It does not touch the game DLL.
let lastVideoFrameAt=0,lastVideoRecoveryAt=0,videoRecoveryAttempts=0;
function renderActualFps(){
  const shown=actualDisplayedFps>0?actualDisplayedFps.toFixed(1):"--";
  const decoded=actualDecodedFps>0?actualDecodedFps.toFixed(1):"--";
  $("actualFps").textContent="표시 "+shown+" / 디코딩 "+decoded+" FPS · "+video.videoWidth+"×"+video.videoHeight;
}
function frameMetrics(timestamp,metadata){
  lastVideoFrameAt=Date.now();
  if(!fpsSince){fpsSince=timestamp;lastPresented=metadata.presentedFrames;}
  if(timestamp-fpsSince>=1000){
    const fps=Math.max(0,Math.round((metadata.presentedFrames-lastPresented)*10000/(timestamp-fpsSince))/10);
    actualDisplayedFps=Number.isFinite(fps)?fps:0;
    renderActualFps();
    fpsSince=timestamp;lastPresented=metadata.presentedFrames;
  }
  if(!document.hidden&&video.srcObject&&typeof video.requestVideoFrameCallback==='function')
    video.requestVideoFrameCallback(frameMetrics);
  else fpsActive=false;
}
function startFrameMetrics(){
  if(fpsActive||typeof video.requestVideoFrameCallback!=='function')return;
  fpsActive=true;fpsSince=0;lastPresented=0;lastVideoFrameAt=Date.now();
  video.requestVideoFrameCallback(frameMetrics);
}
$("expandVideo").addEventListener("click",()=>{
  document.body.classList.toggle("reflex-theater");
  $("expandVideo").textContent=document.body.classList.contains("reflex-theater")
    ?(ko?"밀서 보기":"SHOW LETTER"):(ko?"넓게 보기":"THEATER");
});
$("fullscreenVideo").addEventListener("click",()=>{
  const surface=$("mouse-element");
  if(document.fullscreenElement)void document.exitFullscreen();
  else if(surface.requestFullscreen)void surface.requestFullscreen();
});


function translate() {
  document.documentElement.lang = ko ? "ko" : "en";
  document.querySelectorAll("[data-ko][data-en]").forEach(node => {
    node.textContent = node.dataset[ko ? "ko" : "en"];
  });
}
function state(message, connected = false) {
  $("status").textContent = message;
  $("status").classList.toggle("connected", connected);
}
function failure(error) {
  $("error").hidden = false;
  $("error").textContent = error instanceof Error ? error.message : String(error);
  $("retry").hidden = false;
  state(ko ? "연결에 실패했습니다." : "Connection failed");
}
function validate() {
  if (mode !== "1" || !/^[a-f0-9]{32}$/.test(session)) {
    throw Error(ko ? "유효한 호스트 초대 링크가 아닙니다." : "Missing or invalid host invitation URL");
  }
  if (!window.isSecureContext || typeof CompressionStream !== "function" ||
      typeof DecompressionStream !== "function" || !window.RTCPeerConnection) {
    throw Error(ko ? "HTTPS 및 최신 Chrome·Edge·Firefox 브라우저가 필요합니다." : "HTTPS and a modern WebRTC-enabled browser are required");
  }
}
async function zip64(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < compressed.length; i += 8192)
    binary += String.fromCharCode(...compressed.subarray(i, i + 8192));
  return btoa(binary);
}
async function unzip64(encoded) {
  if (!encoded || encoded.length > MAX_CODE_LENGTH || !/^[A-Za-z0-9+/=]+$/.test(encoded))
    throw Error("Invalid connection code");
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const raw = await new Response(stream).text();
  if (raw.length > 200000) throw Error("Decompressed signal exceeds the safety limit");
  return JSON.parse(raw);
}
async function parseResponse(text) {
  if (typeof text !== "string" || text.length > MAX_CODE_LENGTH + 256) throw Error("Connection code too long");
  let envelope;
  try { envelope = JSON.parse(text.trim()); } catch { throw Error("Paste the complete Darkest Reflex response code"); }
  if (envelope.version !== 1 || envelope.kind !== "answer" || envelope.session !== session ||
      typeof envelope.signal !== "string")
    throw Error(ko ? "이 초대장에 맞지 않는 응답 코드입니다." : "This response belongs to another invitation");
  const parts = envelope.signal.split(";");
  if (parts.length !== 2) throw Error("Invalid SDP/ICE response format");
  const answer = await unzip64(parts[0]);
  const candidates = await unzip64(parts[1]);
  if (!answer || answer.type !== "answer" || typeof answer.sdp !== "string" ||
      !Array.isArray(candidates) || candidates.length > 128)
    throw Error("Invalid WebRTC answer or candidates");
  return {answer, candidates};
}
function awaitIceComplete(connection, collected, timeout = 22000) {
  return new Promise(resolve => {
    if (connection.iceGatheringState === "complete") return resolve();
    let finished = false;
    let timer;
    const onIce = event => {
      if (event.candidate && collected.length < 128) collected.push(event.candidate.toJSON());
      else if (!event.candidate) finish();
    };
    const onState = () => {
      if (connection.iceGatheringState === "complete") finish();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      connection.removeEventListener("icecandidate", onIce);
      connection.removeEventListener("icegatheringstatechange", onState);
      resolve();
    };
    connection.addEventListener("icecandidate", onIce);
    connection.addEventListener("icegatheringstatechange", onState);
    timer = setTimeout(finish, timeout);
  });
}
function send(channel, value) {
  if (channel && channel.readyState === "open") channel.send(value);
}
function resetMedia() {
  resetGpuVideo(false);
  fallbackVideoTrack = null;
  clearInterval(streamRequest);
  streamRequest = null;
  pendingMediaCandidates = [];
  negotiationDone = false;
  if (mediaPeer) mediaPeer.close();
  mediaPeer = null;
  for (const track of media.getTracks()) media.removeTrack(track);
  video.srcObject = null;
  gameAudio.pause();gameAudio.srcObject=null;
  remoteAudioTrack=false;clearInterval(audioStatTimer);audioStatTimer=undefined;
  audioPackets=0;audioState();
  fpsActive=false;fpsSince=0;actualDisplayedFps=0;actualDecodedFps=0;lastVideoFrameAt=0;$("actualFps").textContent="FPS --";
  $("awaitStream").hidden = false;
  $("retryVideo").hidden = true;
}
function releaseControls() {
  $("p2VirtualPointer").hidden=true;
  $("p2VirtualPointer").classList.remove("press");
  $("mouse-element").classList.remove("p2-pointer-active");
  for (const key of heldKeys) send(keyboard, key + "_0");
  heldKeys.clear();
  send(mouse, new Uint8Array([0, 0, 1]));
  send(mouse, new Uint8Array([0, 2, 1]));
}
function disconnect() {
  active = false;
  releaseControls();
  clearInterval(heartbeat);
  heartbeat = null;
  resetMedia();
  if (peer) peer.close();
  peer = null;
  keyboard = null; mouse = null; streamSignal = null;
  previousX=-1;previousY=-1;ackGameSize=null;
  $("p2VirtualCursor").hidden=true;$("p2VirtualCursor").classList.remove("pressed");
  $("p2NativeCursor").hidden=true;$("p2AckStatus").textContent=ko?"P2: 게임 입력 확인 대기":"P2: awaiting game ACK";
  $("gamePanel").hidden = true;
}
function focusGame(event) {
  if (!active || !keyboard || keyboard.readyState !== "open") return false;
  if (document.activeElement !== $("mouse-element")) return false;
  if (["INPUT", "TEXTAREA", "BUTTON"].includes(event.target?.tagName)) return false;
  return true;
}
function onKeyDown(event) {
  if (!focusGame(event)) return;
  if (event.key === "Escape") {
    releaseControls();
    $("mouse-element").blur();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat || heldKeys.has(event.key)) return;
  heldKeys.add(event.key);
  send(keyboard, event.key + "_1");
}
function onKeyUp(event) {
  if (!active || !heldKeys.has(event.key)) return;
  heldKeys.delete(event.key);
  send(keyboard, event.key + "_0");
  event.preventDefault();
}
let previousX=-1,previousY=-1;
let ackGameSize=null;

// The video may contain a DWM title bar and border (e.g. 1368x800),
// while the game ACK reports the real client area (1366x768).
// Match the host's conservative ClientRectCrop policy exactly; do not
// guess when the capture is scaled, fullscreen or resolution is unknown.
function videoClientBounds(){
  const rect=video.getBoundingClientRect();
  const sw=video.videoWidth,sh=video.videoHeight;
  if(sw<2||sh<2||rect.width<=0||rect.height<=0)return null;
  const scale=Math.min(rect.width/sw,rect.height/sh);
  const fullX=rect.left+(rect.width-sw*scale)/2;
  const fullY=rect.top+(rect.height-sh*scale)/2;
  let sx=0,sy=0,cw=sw,ch=sh;
  if(ackGameSize){
    const {w,h}=ackGameSize;
    const dx=sw-w,dy=sh-h;
    if(dx>=0&&dx<=16&&dy>=20&&dy<=80&&w%2===0&&h%2===0){
      sx=Math.floor(dx/2);sy=dy-1;cw=w;ch=h;
    }
  }
  return {left:fullX+sx*scale,top:fullY+sy*scale,width:cw*scale,height:ch*scale};
}
function pointerAt(event){
  const bounds=videoClientBounds();
  if(!bounds)return null;
  if(event.clientX<bounds.left||event.clientX>bounds.left+bounds.width||
     event.clientY<bounds.top||event.clientY>bounds.top+bounds.height)return null;
  return {
    x:Math.max(0,Math.min(10000,Math.round((event.clientX-bounds.left)/bounds.width*10000))),
    y:Math.max(0,Math.min(10000,Math.round((event.clientY-bounds.top)/bounds.height*10000)))
  };
}
// Mirror the transmitted 0..10000 cursor coordinate on top of the game.
 // This shows what the browser SENT, not an unverified claim the game clicked.
function drawP2Pointer(point){
 const marker=$("p2VirtualPointer"),surface=$("mouse-element");
 const r=video.getBoundingClientRect(),outer=surface.getBoundingClientRect();
 const ratio=Math.min(r.width/video.videoWidth,r.height/video.videoHeight);
 const w=video.videoWidth*ratio,h=video.videoHeight*ratio;
 marker.style.left=(r.left-outer.left+(r.width-w)/2+point.x*w/10000)+'px';
 marker.style.top=(r.top-outer.top+(r.height-h)/2+point.y*h/10000)+'px';
 marker.hidden=false;
 surface.classList.add('p2-pointer-active');
}
function sendMove(event,force=false) {
  if (!active || mouse?.readyState !== "open") return false;
  const point=pointerAt(event);
  if(!point)return false;
  // Render only the game image cursor; never a second browser crosshair.
  $("mouse-element").classList.add("p2-pointer-active");
  if(!force&&point.x===previousX&&point.y===previousY)return true;
  previousX=point.x;previousY=point.y;
  const data=new ArrayBuffer(9),v=new DataView(data);
  v.setUint8(0,1);v.setUint16(1,point.x);v.setUint16(3,point.y);
  v.setUint16(5,10000);v.setUint16(7,10000);
  send(mouse,data);
  return true;
}
function onClick(event) {
  if (!active || mouse?.readyState !== "open"||(event.button!==0&&event.button!==2))return;
  if(!sendMove(event,true))return;
  if(event.type==="mousedown")$("mouse-element").focus();
  event.preventDefault();
  send(mouse,new Uint8Array([0,event.button,event.type==="mousedown"?0:1]));
}
function acceptGameCursorAck(raw){
 if(typeof raw!=='string'||raw.length>160||!raw.startsWith('RFA1:'))return;
 const p=raw.slice(5).split(':').map(Number);
 if(p.length!==7||p.some(x=>!Number.isFinite(x)))return;
 const [seq,x,y,w,h,flags,buttons]=p;
 if(seq<=0||w<160||h<120||w>8192||h>8192||x<0||y<0||x>w||y>h)return;
 ackGameSize={w,h};
 const marker=$("p2NativeCursor"),bounds=videoClientBounds();
 const outer=$("mouse-element").getBoundingClientRect();
 if(!bounds)return;
 marker.style.left=(bounds.left-outer.left+x/w*bounds.width)+'px';
 marker.style.top=(bounds.top-outer.top+y/h*bounds.height)+'px';
 marker.hidden=true;marker.classList.toggle("inactive",(flags&1)===0);
 $("p2AckStatus").textContent=(flags&1)?(ko?'P2: 게임 커서 확인됨':'P2: game accepted'):
   (ko?'P2: 게임 수신 · 입력 모드 비활성':'P2: received, input mode inactive');
}
function activateControls() {
  mouse.onmessage = e => acceptGameCursorAck(e.data);
  keyboard.onopen = () => {
    heartbeat = setInterval(() => send(keyboard, "alive_1"), 750);
    send(keyboard, "alive_1");
  };
  keyboard.onclose = () => {clearInterval(heartbeat); releaseControls();};
  $("mouse-element").addEventListener("mousemove", sendMove);
  $("mouse-element").addEventListener("mouseleave",()=>{$("p2VirtualPointer").hidden=true;$("mouse-element").classList.remove("p2-pointer-active")});
  $("mouse-element").addEventListener("mousedown", onClick);
  $("mouse-element").addEventListener("mouseup", onClick);
  $("mouse-element").addEventListener("contextmenu", event => event.preventDefault());
}
async function ensureSound(){
 const available=gameAudio.srcObject instanceof MediaStream &&
   gameAudio.srcObject.getAudioTracks().some(t=>t.readyState==='live');
 $("sound").hidden=false;
 if(!available){
   $("sound").textContent=ko?'소리 전달 대기':'WAITING FOR GAME AUDIO';audioState();return;
 }
 gameAudio.muted=false;gameAudio.volume=1;
 try{
   await gameAudio.play();
   $("sound").textContent=ko?'게임 소리 재생 중':'GAME AUDIO PLAYING';
 }catch(e){
   $("sound").textContent=ko?'게임 소리 켜기':'ENABLE GAME SOUND';
   console.warn('[REFLEX_AUDIO] Audio needs user gesture',e?.name||e);
 }
 audioState();
}

const REFLEX_GPU_GUEST_PROTOCOL = "DR_GPU_GUEST_V2_20261029";
function resetGpuVideo(restore = true) {
  ++gpuEpoch;
  if (gpuStatsTimer) clearInterval(gpuStatsTimer);
  if (gpuConnectTimeout) clearTimeout(gpuConnectTimeout);
  gpuStatsTimer = null; gpuConnectTimeout = null;
  const old = gpuPeer; gpuPeer = null;
  if (old) old.close();
  if (gpuVideoTrack) media.removeTrack(gpuVideoTrack);
  gpuVideoTrack = null;
  pendingGpuCandidates = [];
  if (restore && fallbackVideoTrack?.readyState === "live") {
    if (!media.getTracks().some(t => t.id === fallbackVideoTrack.id)) media.addTrack(fallbackVideoTrack);
    video.srcObject = media;
    $("peerStatus").textContent = "video: legacy fallback";
  }
}
async function handleGpuSignal(message) {
  if (!active || streamSignal?.readyState !== "open") return;
  if (message.type === "candidate" && message.candidate) {
    if (gpuPeer?.remoteDescription) {
      try { await gpuPeer.addIceCandidate(message.candidate); } catch (e) { console.warn("[REFLEX_GPU] candidate rejected",e); }
    } else if (pendingGpuCandidates.length < 64) pendingGpuCandidates.push(message.candidate);
    return;
  }
  if (message.type !== "offer" || !message.offer || gpuPeer) return;
  const gpu = new RTCPeerConnection({iceServers: STUN_ONLY});
  gpuPeer = gpu; const epoch = ++gpuEpoch;
  $("peerStatus").textContent = "video: GPU H.264 negotiating";
  console.info("[REFLEX_GPU] "+REFLEX_GPU_GUEST_PROTOCOL+" received H264 offer");
  gpu.addEventListener("icecandidate", event => {
    if (gpuPeer !== gpu || !event.candidate) return;
    send(streamSignal, JSON.stringify({type:"candidate", role:"gpu-client", candidate:event.candidate.toJSON()}));
  });
  gpu.addEventListener("track", event => {
    if (gpuPeer !== gpu || event.track.kind !== "video") return;
    fallbackVideoTrack = media.getVideoTracks().find(t=>t!==gpuVideoTrack) || fallbackVideoTrack;
    for(const old of media.getVideoTracks()) media.removeTrack(old);
    gpuVideoTrack = event.track;
    media.addTrack(event.track);
    video.srcObject = media;
    video.muted = true;
    void video.play().catch(e=>console.warn("[REFLEX_GPU] autoplay blocked",e));
    $("awaitStream").hidden = true;
    $("peerStatus").textContent = "video: GPU H.264 decoded";
    startFrameMetrics();
    console.info("[REFLEX_GPU] decoded H264 track connected");
    event.track.addEventListener("ended",()=>{
      if(gpuPeer === gpu) resetGpuVideo(true);
    },{once:true});
  });
  gpu.addEventListener("connectionstatechange",()=>{
    if(gpuPeer!==gpu)return;
    console.info("[REFLEX_GPU] peer state="+gpu.connectionState);
    if(gpu.connectionState==="failed"||gpu.connectionState==="closed"){
      resetGpuVideo(true);
    }
  });
  gpuConnectTimeout = setTimeout(()=>{
    if(gpuPeer===gpu && !gpuVideoTrack){
      console.warn("[REFLEX_GPU] no decoded video track in 15s");
      resetGpuVideo(true);
    }
  },15000);
  gpuStatsTimer=setInterval(()=>{
    if(gpuPeer!==gpu||epoch!==gpuEpoch)return;
    void gpu.getStats().then(stats=>{
      stats.forEach(r=>{
        if(r.type==="inbound-rtp"&&r.kind==="video"){
          const count=Number(r.jitterBufferEmittedCount||0);
          const jitterMs=count>0?Math.round(1000*Number(r.jitterBufferDelay||0)/count):0;
          console.info("[REFLEX_GPU] guest framesDecoded="+Number(r.framesDecoded||0)+
            " fps="+Number(r.framesPerSecond||0)+" jitterMs="+jitterMs);
          actualDecodedFps=Number(r.framesPerSecond||0);
          renderActualFps();
        }
      });
    }).catch(()=>{});
  },5000);
  try{
    await gpu.setRemoteDescription(message.offer);
    for(const candidate of pendingGpuCandidates.splice(0)){
      try{ await gpu.addIceCandidate(candidate); }catch(e){console.warn("[REFLEX_GPU] queued ICE",e);}
    }
    const answer=await gpu.createAnswer();
    await gpu.setLocalDescription(answer);
    send(streamSignal, JSON.stringify({type:"answer", role:"gpu-client",answer:gpu.localDescription.toJSON()}));
    console.info("[REFLEX_GPU] native H264 SDP answer transmitted");
  }catch(err){
    console.warn("[REFLEX_GPU] native H264 negotiation failed",err);
    if(gpuPeer===gpu)resetGpuVideo(true);
  }
}

async function startMedia() {
  if (mediaPeer || !active || streamSignal?.readyState !== "open") return;
  state(ko ? "협력자 연결됨 · 원정의 광경을 요청하는 중..." : "P2 connected · requesting game video...", true);
  $("peerStatus").textContent = "video: requesting";
  mediaPeer = new RTCPeerConnection({iceServers: STUN_ONLY});
   audioStatTimer=setInterval(()=>{
     if(!mediaPeer||mediaPeer.connectionState==='closed')return;
     void mediaPeer.getStats().then(reports=>{
       reports.forEach(r=>{if(r.type==='inbound-rtp'&&r.kind==='audio')audioPackets=r.bytesReceived||0});
       if(remoteAudioTrack&&audioPackets===0)
         $("audioStatus").textContent=ko?'오디오 트랙 연결됨 · 데이터 대기':'Audio track connected, no data';
       else audioState();
     }).catch(()=>{});
   },2500);
  const current = mediaPeer;
  const combined = media;
  current.addEventListener("track", event => {
    if (mediaPeer !== current) return;
    if (event.track.kind === 'video' && gpuVideoTrack?.readyState === 'live') {
      fallbackVideoTrack = event.track;
      return;
    }
    if (!combined.getTracks().some(track => track.id === event.track.id))
      combined.addTrack(event.track);
    video.srcObject = combined;
    if(event.track.kind==='audio'){
      remoteAudioTrack=true;
      gameAudio.srcObject=new MediaStream([event.track]);
      event.track.addEventListener('ended',()=>{remoteAudioTrack=false;audioState()},{once:true});
      console.info('[REFLEX_AUDIO] isolated game sound track arrived');
      void ensureSound();
      return;
    }
    // Keep video muted; only the dedicated element outputs remote game audio.
    video.muted=true;
    lastVideoFrameAt=Date.now();
    // A track event only means SDP negotiation, not that a decoded frame
    // arrived. Retain the waiting overlay until the video actually plays.
    const revealVideo = () => {
      startFrameMetrics();
      if (mediaPeer !== current) return;
      $("awaitStream").hidden = true;
      $("retryVideo").hidden = true;
      $("peerStatus").textContent = "video: receiving";
      state(ko ? "협력자의 원정 광경을 수신하고 있습니다." : "Receiving host game video", true);
    };
    video.addEventListener("loadeddata", revealVideo, {once:true});
    event.track.addEventListener("unmute", revealVideo, {once:true});
    void ensureSound();
  });
  current.addEventListener("icecandidate", event => {
    if (mediaPeer !== current) return;
    if (event.candidate) {
      send(streamSignal, JSON.stringify({type: "candidate", candidate: event.candidate.toJSON(), role: "client"}));
    } else if (current.localDescription) {
      send(streamSignal, JSON.stringify({type: "answer", answer: current.localDescription.toJSON(), role: "client"}));
    }
  });
  current.addEventListener("connectionstatechange", () => {
    $("peerStatus").textContent = current.connectionState;
    if (current.connectionState === "failed" || current.connectionState === "closed") {
      state(ko ? "원정의 광경이 끊어졌습니다." : "Video connection lost");
      $("awaitStream").hidden = false;
      $("retryVideo").hidden = false;
    }
  });
  let attempts = 0;
  const ready = () => {
    if (negotiationDone || streamSignal?.readyState !== "open") {
      clearInterval(streamRequest); return;
    }
    if (attempts++ >= 30) {
      clearInterval(streamRequest);
      $("peerStatus").textContent = "video: host did not offer";
      $("retryVideo").hidden = false;
      state(ko ? "협력자의 조작 통로는 열렸으나 영상이 도착하지 않았습니다. 가주에게 ‘원정 영상 재개’를 요청하십시오."
                : "P2 controls connected, but no video offer received. Ask host to press Restart Game Video.");
      return;
    }
    if (attempts === 4 || attempts === 12) {
      state(ko ? "호스트가 게임 창을 캡처할 때까지 기다리는 중..." : "Waiting for host game capture...", true);
    }
    // This exact capability packet is recognized by the native Windows host.
    // Signal first on the same ordered data channel, then request the media offer.
    send(streamSignal, '{"type":"reflex-gpu-capability","supported":true}');
    send(streamSignal, "{}");
  };
  streamRequest = setInterval(ready, 1500);
  ready();
}
async function onMediaSignal(event) {
  if (!mediaPeer) return;
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.role === "gpu-host") {
    await handleGpuSignal(message);
    return;
  }
  if (message.role !== "host") return;
  if (message.type === "status") {
    mediaStage = typeof message.stage === "string" ? message.stage : "";
    const detail = typeof message.detail === "string" ? message.detail.slice(0,300) : "";
    if (mediaStage === "capture-restarting") {
      resetMedia();
      if (active) startMedia();
      state(ko ? "호스트가 게임 영상 송출을 다시 시작하는 중..." : "Host is restarting the game video...", true);
    } else if (mediaStage === "capture-starting") {
      state(ko ? "호스트가 다키스트 던전 게임 창을 캡처하는 중..." : "Host is capturing the Darkest Dungeon window...", true);
    } else if (mediaStage === "capture-failed") {
      // A failed native capture cannot produce an offer. Stop retry spam
      // and preserve the actionable capture error until the host retries.
      clearInterval(streamRequest);
      streamRequest = null;
      $("peerStatus").textContent = "video: capture failed";
      state(ko ? "호스트에서 게임 영상 캡처에 실패했습니다. 호스트 화면의 오류를 확인하세요."
                : "Game-only capture failed. Check the host app for details.");
      if (detail && lastMediaNotice !== detail) {
        lastMediaNotice = detail;
        $("error").textContent = "Host capture error: " + detail;
        $("error").hidden = false;
      }
    } else if (mediaStage === "stream-offer-sent") {
      state(ko ? "호스트 영상 신호 전송됨. 영상 연결 중..." : "Host sent video offer. Negotiating media...", true);
    }
    return;
  }
  if (message.type === "candidate") {
    if (!message.candidate) return;
    if (!mediaPeer.remoteDescription) {
      if (pendingMediaCandidates.length < 128) pendingMediaCandidates.push(message.candidate);
    } else await mediaPeer.addIceCandidate(message.candidate).catch(() => {});
    return;
  }
  if (message.type !== "offer" || !message.offer || negotiationDone) return;
  negotiationDone = true;
  clearInterval(streamRequest);
  $("error").hidden = true;
  const pc = mediaPeer;
  try {
    await pc.setRemoteDescription(message.offer);
    for (const candidate of pendingMediaCandidates.splice(0)) {
      await pc.addIceCandidate(candidate).catch(() => {});
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (pc.iceGatheringState === "complete" && pc.localDescription)
      send(streamSignal, JSON.stringify({type:"answer",answer:pc.localDescription.toJSON(),role:"client"}));
  } catch (error) {
    negotiationDone = false;
    // A malformed answer or a temporary codec error must not leave the user
    // stuck with an acknowledged offer but no video retry possibility.
    failure(error);
    resetMedia();
    if (active) startMedia();
  }
}
// Recover stalled game video without disconnecting the P2 control peer.
// Only try twice, with a 25s cooldown; hidden browser tabs are not diagnosed
// as stalls because requestVideoFrameCallback may be throttled.
setInterval(()=>{
  if(!active||busy||document.hidden||!mediaPeer||!video.srcObject||
     streamSignal?.readyState!=="open"||!lastVideoFrameAt)return;
  const now=Date.now();
  if(now-lastVideoFrameAt<12000||now-lastVideoRecoveryAt<25000||videoRecoveryAttempts>=2)return;
  videoRecoveryAttempts++;
  lastVideoRecoveryAt=now;
  console.warn("[REFLEX_VIDEO_STALL] no presented frame for 12s; media-only reconnect attempt="+videoRecoveryAttempts);
  $("peerStatus").textContent="video: reconnecting after frame stall";
  resetMedia();
  void startMedia();
},4000);

async function prepare() {
  if (busy) return;
  busy = true; $("error").hidden = true; $("retry").hidden = true;
  disconnect();
  try {
    validate();
    state(ko ? "협력 요청서를 작성하는 중..." : "Creating direct P2P request...");
    peer = new RTCPeerConnection({iceServers: STUN_ONLY});
    peer.addEventListener("connectionstatechange", () => {
      if (!peer) return;
      const cs = peer.connectionState;
      if (cs === "connected") {
        active = true;
        $("manual").hidden = true;
        $("gamePanel").hidden = false;
        state(ko ? "협력자와 연결됐습니다." : "Connected directly to host", true);
        if (streamSignal?.readyState === "open") void startMedia();
      } else if (cs === "failed" || cs === "closed" || cs === "disconnected") {
        if (active) {releaseControls(); state(ko ? "협력자와의 연결이 끊겼습니다." : "Host connection interrupted");}
      }
    });
    peer.createDataChannel("controller");
    streamSignal = peer.createDataChannel("streaming-signal");
    keyboard = peer.createDataChannel("keyboard");
    mouse = peer.createDataChannel("mouse");
    streamSignal.onopen = () => {if (active) void startMedia();};
    streamSignal.onmessage = event => {void onMediaSignal(event);};
    activateControls();
    const offer = await peer.createOffer();
    const candidateArray = [];
    const gathered = awaitIceComplete(peer, candidateArray);
    await peer.setLocalDescription(offer);
    await gathered;
    const description = await zip64(peer.localDescription.toJSON());
    const candidates = await zip64(candidateArray);
    $("offer").value = JSON.stringify({version: 1, session, kind: "offer", signal: description + ";" + candidates});
    $("manual").hidden = false;
    $("connect").disabled = false;
    state(ko ? "① 협력 요청서를 가주에게 전하십시오." : "① Send your request to the host");
  } catch (error) {
    disconnect();
    failure(error);
  } finally {busy = false;}
}
async function applyAnswer() {
  if (busy || !peer) return;
  busy = true; $("error").hidden = true;
  $("connect").disabled = true;
  try {
    const {answer, candidates} = await parseResponse($("answer").value);
    state(ko ? "P2P 연결 중. 네트워크에 따라 수 초 걸립니다..." : "Connecting to host peer...");
    await peer.setRemoteDescription(answer);
    for (const candidate of candidates) await peer.addIceCandidate(candidate).catch(() => {});
  } catch (error) {
    failure(error);
    $("connect").disabled = false;
  } finally {busy = false;}
}
function setTheme(theme){
  const mode=theme==='classic'?'classic':'letter';
  document.body.classList.toggle('letter',mode==='letter');
  try{localStorage.setItem('darkest-reflex-guest-theme',mode)}catch(e){}
  $("guestLetter").setAttribute('aria-pressed',String(mode==='letter'));
  $("guestClassic").setAttribute('aria-pressed',String(mode==='classic'));
}
let initialTheme='letter';
try{initialTheme=localStorage.getItem('darkest-reflex-guest-theme')||'letter'}catch(e){}
setTheme(initialTheme);
$("guestLetter").addEventListener("click",()=>setTheme('letter'));
$("guestClassic").addEventListener("click",()=>setTheme('classic'));
translate();
$("answer").addEventListener("input", () => $("connect").disabled = !$("answer").value.trim() || busy);
$("copyOffer").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("offer").value);
    state(ko ? "청원서를 필사했습니다. 가주에게 전하십시오." : "Request copied. Send to host.");
  } catch {
    $("offer").select();
    state(ko ? "자동 필사가 막혔습니다. 요청 서신을 직접 복사하십시오." : "Clipboard blocked. Select and copy the request.");
  }
});
$("connect").addEventListener("click", () => {void applyAnswer();});
$("retry").addEventListener("click", () => {void prepare();});
$("sound").addEventListener("click", () => {void ensureSound();});
$("retryVideo").addEventListener("click", () => {
  if (!active) return;
  resetMedia();
  $("error").hidden = true;
  void startMedia();
});
$("disconnect").addEventListener("click", () => {
  disconnect();
  state(ko ? "동행을 마쳤습니다." : "Disconnected");
  $("retry").hidden = false;
});
document.addEventListener("keydown", onKeyDown, true);
document.addEventListener("keyup", onKeyUp, true);
window.addEventListener("blur", releaseControls);
document.addEventListener("visibilitychange", () => {if (document.hidden) releaseControls();});
window.addEventListener("beforeunload", disconnect);
void prepare();
