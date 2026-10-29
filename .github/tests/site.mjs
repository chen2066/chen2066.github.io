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
assert(js.includes("drawP2Pointer(point)"),"P2 cursor must reflect transmitted normalized game coordinates");
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
assert(js.includes('indicator.style.left='),"Visible P2 marker must follow normalized video pointer");

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
