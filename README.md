# Darkest Reflex · Remote P2 Browser Guest

**Public guest website:** https://chen2066.github.io/join/

Independent, MIT-licensed WebRTC client for the Darkest Reflex game-only co-op mod.

The private game DLL and Windows host sources are **not copied to this public repository**. The site publishes only HTML/CSS/JS written for the guest, plus the MIT license. It does not store invitations, run a signaling server, proxy game media, or use paid TURN.

## Join a friend

1. The Windows host starts *Darkest Reflex Remote* by pressing **Ctrl+F8** in Darkest Dungeon.
2. Select **무료 직접 연결 시작**.
3. The host sends the invitation link to the friend.
4. The friend opens the link in a modern HTTPS browser, copies the **request code**, and sends it to the host through their existing chat.
5. The host pastes the request and clicks **연결 응답 생성**, then sends the response code back.
6. The friend pastes the response and clicks **던전 입장**. Video, audio and the game-only P2 input are transmitted directly over WebRTC if NAT traversal succeeds.

**No one needs a Render or Parsec account.** Hosting static files on GitHub Pages does not relay the video. Direct WebRTC may fail on CGNAT, symmetric NAT, or restricted networks without TURN.

P2 input is limited **by the Windows host and Darkest Reflex game bridge**, not by the website alone. The host must run a compatible updated Darkest Reflex Remote build.

Connection codes may expose network addresses. Share only with someone you trust.

## Deploy / GitHub Pages

This repository is a GitHub user site. Main-branch Pages can publish the root `index.html` and `join/index.html`. A GitHub Actions workflow also validates the client and deploys only those static files.

If deployment is not already enabled, repository owner:
**Settings → Pages → Build and deployment → Source: GitHub Actions**.

Check [Actions](https://github.com/chen2066/chen2066.github.io/actions) for the job `Publish Darkest Reflex Remote P2 Browser Guest`.

The live browser page can be tested without exposing private code. The final host–guest game test needs two actual network endpoints.

## Source licensing

This standalone guest is MIT-licensed. The main Windows host is based on LibreRemotePlay and has separate GPL-3.0 obligations; licensing of this isolated guest does not change that.
