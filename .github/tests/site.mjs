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
assert(js.includes("v.setUint16(5,10000)"),"Normalized dimensions must match game IPC");
assert(html.includes('id="guestLetter"')&&html.includes('id="guestClassic"'),"Both themes must be selectable");
assert(js.includes("setTheme(initialTheme)"),"Theme preference must be restorable");
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
