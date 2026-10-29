import {readFileSync} from "node:fs";
import {strict as assert} from "node:assert";
import {spawnSync} from "node:child_process";

const html=readFileSync("join/index.html","utf8");
const js=readFileSync("join/guest.js","utf8");
const css=readFileSync("join/guest.css","utf8");
assert(html.includes("guest.js") && html.includes("guest.css"));
assert(html.includes('id="stream-video"'));
assert(html.includes('id="offer"'));
assert(html.includes('id="answer"'));
assert(js.includes('CompressionStream("gzip")'));
assert(js.includes('DecompressionStream("gzip")'));
assert(js.includes("video.getBoundingClientRect()"),"Pointer mapping must use real video bounds");
assert(js.includes("sendMove(event,true)"),"Click must send accurate video pointer first");
assert(html.includes('id="p2VirtualPointer"'),"P2 browser pointer marker must exist");
assert(css.includes("pointer-events:none"),"P2 cursor overlay must never intercept clicks");
assert(js.includes("v.setUint16(5,10000)"),"Normalized dimensions must match game IPC");
assert(html.includes('id="guestLetter"')&&html.includes('id="guestClassic"'),"Both themes must be selectable");
assert(js.includes("setTheme(initialTheme)"),"Theme preference must be restorable");
assert(html.includes('id="audioStatus"'),"Guest must show actual audio status");
assert(js.includes("new MediaStream([event.track])"),"Audio playback must isolate the game-only audio track");
assert(js.includes("r.type==='inbound-rtp'&&r.kind==='audio'"),"Guest must distinguish audio packets received from no audio");
assert(js.includes("await gameAudio.play()"),"Audio must require a real browser play operation");
assert(js.includes("gameAudio.pause();gameAudio.srcObject=null"),"Guest must release audio on disconnect");
assert(html.includes('id="fullscreenVideo"')&&html.includes('id="expandVideo"'),"Guest must expose larger and fullscreen viewing");
assert(js.includes("requestVideoFrameCallback(frameMetrics)"),"Guest FPS must measure decoded frames, not promised FPS");
assert(js.includes("document.fullscreenElement"),"Fullscreen must have a safe exit");
assert(css.includes("max-width:min(97vw,1640px)"),"Guest viewing panel must exceed obsolete 940px limit");
assert(css.includes("#mouse-element:fullscreen"),"Video overlay must remain isolated in fullscreen");
assert(js.includes('new RTCPeerConnection({iceServers: STUN_ONLY})'));
assert(!/turn:|turns:/i.test(js), "Paid TURN is forbidden");
assert(!/fetch\s*\(/i.test(js), "Manual P2P must not call an invite server API");

const syntax=spawnSync(process.execPath, ["--check", "join/guest.js"], {encoding:"utf8"});
assert.equal(syntax.status,0,syntax.stderr);

// The host Go signal codec uses json -> gzip -> base64.StdEncoding.
// Exercise browser-standard gzip and the inverse against that wire format.
const offer={type:"offer",sdp:"v=0\r\na=group:BUNDLE 0\r\na=ice-ufrag:sample"};
const bytes=new TextEncoder().encode(JSON.stringify(offer));
const gzStream=new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
const compressed=new Uint8Array(await new Response(gzStream).arrayBuffer());
const zipped=Buffer.from(compressed).toString("base64");
const unzipped=await new Response(new Blob([Buffer.from(zipped,"base64")]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
assert.deepEqual(JSON.parse(unzipped),offer);
console.log("PASS: standalone website files, JS syntax, no relay calls, no TURN, and gzip/base64 SDP codec");

assert(html.includes('id="p2VirtualCursor"'),"P2 game-local pointer overlay required");
assert(css.includes("#p2VirtualCursor")&&css.includes("pointer-events:none"),"P2 cursor must never intercept actual browser click events");

assert(js.includes("mouse.onmessage = e => acceptGameCursorAck(e.data)"),"Game ACK must be delivered to guest");
assert(js.includes("p2NativeCursor"),"Must distinguish native game cursor from transmitted browser target");
assert(html.includes('id="p2AckStatus"'),"Guest ACK state must be visible");
assert(css.includes('#p2NativeCursor')&&css.includes('pointer-events:none'),"Native cursor marker may not steal clicks");

// GPU video must negotiate over the existing authenticated P2 media signal.
// The original controller, game-only audio and manual invitation remain untouched.
assert(js.includes('DR_GPU_GUEST_V2_20261029'),'Published standalone guest must include native GPU implementation');
assert(js.includes('reflex-gpu-capability'),'Published guest must announce native GPU support to host');
assert(js.indexOf('reflex-gpu-capability')<js.lastIndexOf('send(streamSignal, "{}")'),'GPU capability must precede capture request');
assert(js.includes('message.role === "gpu-host"'),'Native H264 offer must be accepted before legacy-host filtering');
assert(js.includes('new RTCPeerConnection({iceServers: STUN_ONLY})'),'GPU H264 receiver must remain P2P and STUN-only');
assert(js.includes('role:"gpu-client"'),'Guest must signal native SDP answer and ICE back to host');
assert(js.includes('gpuVideoTrack = event.track'),'Native video must replace only visual track');
assert(js.includes('if(event.track.kind===\'audio\')') && js.includes('gameAudio.srcObject=new MediaStream([event.track])'),'Standalone game audio must remain independent');
assert(js.includes('send(keyboard, event.key + "_1")'),'P2 key down protocol must remain intact');

assert(!js.includes("  drawP2Pointer(point);"),"Do not draw a second browser pointer");
assert(css.includes("#p2VirtualPointer,#p2VirtualCursor,#p2NativeCursor{display:none!important"),"Hide all redundant browser pointers");
assert(js.includes("renderActualFps()"),"Measure display and decode FPS");

assert(js.includes("[REFLEX_VIDEO_STALL]"),"Frame stall recovery logging must exist");
assert(js.includes("videoRecoveryAttempts>=2"),"Media reconnection retries must be bounded");
assert(js.includes("resetMedia();\n  void startMedia();"),"Recover only video peer, not controller");
assert(js.includes("document.hidden"),"Do not diagnose background-tab throttling as video failure");



// Validate the guest cursor transform against actual WGC non-client padding.
// Use a tiny DOM/video stub so this test never opens a real WebRTC session.
{
  const vm=await import("node:vm");
  const begin=js.indexOf("let previousX=-1,previousY=-1;");
  const end=js.indexOf("// Mirror the transmitted",begin);
  assert(begin>=0&&end>begin,"P2 coordinate functions must be present");
  const context={video:{
    videoWidth:1368,videoHeight:800,
    getBoundingClientRect:()=>({left:20,top:30,width:684,height:400})
  }};
  vm.runInNewContext(js.slice(begin,end),context);
  vm.runInNewContext("ackGameSize={w:1366,h:768}",context);
  const bounds=vm.runInNewContext("videoClientBounds()",context);
  assert.equal(bounds.left,20.5);
  assert.equal(bounds.top,45.5);
  assert.equal(bounds.width,683);
  assert.equal(bounds.height,384);
  const outside=vm.runInNewContext("pointerAt({clientX:21,clientY:31})",context);
  assert.equal(outside,null,"Clicks in the window title bar must not become game clicks");
  const leftTop=vm.runInNewContext("pointerAt({clientX:20.5,clientY:45.5})",context);
  assert.equal(leftTop.x,0);assert.equal(leftTop.y,0);
  const rightBottom=vm.runInNewContext("pointerAt({clientX:703.5,clientY:429.5})",context);
  assert.equal(rightBottom.x,10000);assert.equal(rightBottom.y,10000);
  context.video.videoWidth=1366;context.video.videoHeight=768;
  context.video.getBoundingClientRect=()=>({left:20,top:30,width:683,height:384});
  const cropped=vm.runInNewContext("videoClientBounds()",context);
  assert.equal(cropped.left,20);assert.equal(cropped.top,30);
  assert.equal(cropped.width,683);assert.equal(cropped.height,384);
  console.log("PASS: ACK-verified client-area pointer coordinates with WGC chrome and GPU cropping");
}
