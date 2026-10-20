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
  clearInterval(streamRequest);
  streamRequest = null;
  pendingMediaCandidates = [];
  negotiationDone = false;
  if (mediaPeer) mediaPeer.close();
  mediaPeer = null;
  for (const track of media.getTracks()) media.removeTrack(track);
  video.srcObject = null;
  $("awaitStream").hidden = false;
  $("retryVideo").hidden = true;
}
function releaseControls() {
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
  previousX=-1;previousY=-1;
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
function pointerAt(event){
  if(video.videoWidth<2||video.videoHeight<2)return null;
  const rect=video.getBoundingClientRect();
  if(rect.width<=0||rect.height<=0)return null;
  const scale=Math.min(rect.width/video.videoWidth,rect.height/video.videoHeight);
  const vw=video.videoWidth*scale,vh=video.videoHeight*scale;
  const x0=rect.left+(rect.width-vw)/2,y0=rect.top+(rect.height-vh)/2;
  if(event.clientX<x0||event.clientX>x0+vw||event.clientY<y0||event.clientY>y0+vh)return null;
  return {
    x:Math.max(0,Math.min(10000,Math.round((event.clientX-x0)/vw*10000))),
    y:Math.max(0,Math.min(10000,Math.round((event.clientY-y0)/vh*10000)))
  };
}
function sendMove(event,force=false) {
  if (!active || mouse?.readyState !== "open") return false;
  const point=pointerAt(event);
  if(!point)return false;
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
function activateControls() {
  keyboard.onopen = () => {
    heartbeat = setInterval(() => send(keyboard, "alive_1"), 750);
    send(keyboard, "alive_1");
  };
  keyboard.onclose = () => {clearInterval(heartbeat); releaseControls();};
  $("mouse-element").addEventListener("mousemove", sendMove);
  $("mouse-element").addEventListener("mousedown", onClick);
  $("mouse-element").addEventListener("mouseup", onClick);
  $("mouse-element").addEventListener("contextmenu", event => event.preventDefault());
}
async function ensureSound() {
  video.muted = false;
  video.volume = 1;
  try {
    await video.play();
    $("sound").hidden = false;
    $("sound").textContent = ko ? "게임 소리 켜짐" : "GAME AUDIO ON";
  } catch {
    video.muted = true;
    await video.play().catch(() => {});
    $("sound").hidden = false;
    $("sound").textContent = ko ? "게임 소리 켜기" : "ENABLE GAME SOUND";
  }
}
async function startMedia() {
  if (mediaPeer || !active || streamSignal?.readyState !== "open") return;
  state(ko ? "협력자 연결됨 · 원정의 광경을 요청하는 중..." : "P2 connected · requesting game video...", true);
  $("peerStatus").textContent = "video: requesting";
  mediaPeer = new RTCPeerConnection({iceServers: STUN_ONLY});
  const current = mediaPeer;
  const combined = media;
  current.addEventListener("track", event => {
    if (mediaPeer !== current) return;
    if (!combined.getTracks().some(track => track.id === event.track.id))
      combined.addTrack(event.track);
    video.srcObject = combined;
    // A track event only means SDP negotiation, not that a decoded frame
    // arrived. Retain the waiting overlay until the video actually plays.
    const revealVideo = () => {
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
    send(streamSignal, "{}");
  };
  streamRequest = setInterval(ready, 1500);
  ready();
}
async function onMediaSignal(event) {
  if (!mediaPeer) return;
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
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
