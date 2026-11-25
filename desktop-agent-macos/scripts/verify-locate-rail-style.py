#!/usr/bin/env python3
"""真机验收：等长居中短杠；禁止连续粗黑竖线 / 深色实心竖轨。"""
import asyncio, base64, json, pathlib, time, urllib.request
import websockets

OUT = pathlib.Path(__file__).resolve().parents[1] / "docs/ui"


def wait_page():
    for _ in range(40):
        try:
            tabs = json.load(urllib.request.urlopen("http://127.0.0.1:9333/json/list"))
            page = next(t for t in tabs if t.get("type") == "page" and "5173" in (t.get("url") or ""))
            return page["webSocketDebuggerUrl"]
        except Exception:
            time.sleep(0.4)
    raise SystemExit("no cdp page")


async def main():
    ws_url = wait_page()
    async with websockets.connect(ws_url, max_size=20_000_000) as ws:
        n = 0

        async def call(method, params=None):
            nonlocal n
            n += 1
            i = n
            await ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == i:
                    return msg

        async def evaluate(expression):
            msg = await call("Runtime.evaluate", {"expression": expression, "returnByValue": True})
            if msg.get("result", {}).get("exceptionDetails"):
                raise RuntimeError(json.dumps(msg["result"]["exceptionDetails"]))
            return msg["result"]["result"].get("value")

        await call("Runtime.enable")
        await asyncio.sleep(0.8)
        opened = await evaluate(
            """(() => {
              const hit = [...document.querySelectorAll('div,button,span,p')].find(n =>
                n.childElementCount === 0 && n.textContent.trim().startsWith('只回答')
              );
              if (!hit) return 'none';
              (hit.closest('button,div') || hit).click();
              return hit.textContent.trim().slice(0, 40);
            })()"""
        )
        print("OPEN", opened)
        await asyncio.sleep(1.0)

        snap = await evaluate(
            """(() => {
              const rail = document.querySelector('.user-msg-locate-rail');
              const spine = document.querySelector('.user-msg-locate-spine');
              const nodes = document.querySelectorAll('.user-msg-locate-node');
              const hits = document.querySelectorAll('.user-msg-locate-hit');
              const bars = document.querySelectorAll('.user-msg-locate-hit-bar');
              const cs = rail ? getComputedStyle(rail) : null;
              const barCs = bars[0] ? getComputedStyle(bars[0]) : null;
              const bg = (cs?.backgroundColor || '').replace(/\\s+/g, '');
              const transparent =
                !bg ||
                bg === 'rgba(0,0,0,0)' ||
                bg === 'transparent' ||
                bg.startsWith('rgba(0,0,0,0)');
              const widths = [...bars].map(b => Math.round(b.getBoundingClientRect().width));
              const hitBox = hits[0]?.getBoundingClientRect();
              const wrap = document.querySelector('.scroll-with-rail');
              const wrapRect = wrap?.getBoundingClientRect();
              const railRect = rail?.getBoundingClientRect();
              const offsetLeft =
                wrapRect && railRect ? Math.round(railRect.left - wrapRect.left) : null;
              return {
                hasRail: !!rail,
                hasSpine: !!spine,
                nodeCount: nodes.length,
                hitCount: hits.length,
                barCount: bars.length,
                bg: cs?.backgroundColor || null,
                transparentRail: transparent,
                barWidths: widths,
                barHeight: barCs ? Math.round(parseFloat(barCs.height)) : null,
                hitWidth: hitBox ? Math.round(hitBox.width) : null,
                hitHeight: hitBox ? Math.round(hitBox.height) : null,
                offsetLeft,
                absoluteRail: cs?.position === 'absolute',
                inDock: !!document.querySelector('.dock .user-msg-locate-rail'),
                inCapsule: !!document.querySelector('.task-plan-capsule .user-msg-locate-rail'),
              };
            })()"""
        )
        print("SNAP", json.dumps(snap, ensure_ascii=False, indent=2))
        shot = await call("Page.captureScreenshot", {"format": "png", "fromSurface": True})
        path = OUT / "locate-rail-style.png"
        path.write_bytes(base64.b64decode(shot["result"]["data"]))
        print("SHOT", path)

        clip = await evaluate(
            """(() => {
              const rail = document.querySelector('.user-msg-locate-rail');
              if (!rail) return null;
              const r = rail.getBoundingClientRect();
              return { x: Math.max(0, r.x - 4), y: r.y, width: Math.max(r.width + 8, 1), height: Math.max(r.height, 1) };
            })()"""
        )
        if clip:
            rail_shot = await call(
                "Page.captureScreenshot",
                {
                    "format": "png",
                    "fromSurface": True,
                    "clip": {
                        "x": clip["x"],
                        "y": clip["y"],
                        "width": clip["width"],
                        "height": clip["height"],
                        "scale": 1,
                    },
                },
            )
            rail_path = OUT / "locate-rail-style-closeup.png"
            rail_path.write_bytes(base64.b64decode(rail_shot["result"]["data"]))
            print("SHOT", rail_path)

        ok = (
            snap
            and snap.get("hasRail")
            and not snap.get("hasSpine")
            and snap.get("nodeCount", 0) == 0
            and snap.get("hitCount", 0) >= 1
            and snap.get("barCount", 0) >= 1
            and snap.get("transparentRail")
            and snap.get("absoluteRail")
            and (snap.get("barHeight") or 0) <= 5
            and (snap.get("barWidths") or [0])[0] >= 14
            and (snap.get("hitWidth") or 0) >= 28
            and (snap.get("hitHeight") or 0) >= 28
            and snap.get("offsetLeft") is not None
            and abs(snap.get("offsetLeft")) <= 2
            and not snap.get("inDock")
            and not snap.get("inCapsule")
        )
        print("PASS" if ok else "FAIL", snap)
        raise SystemExit(0 if ok else 2)


asyncio.run(main())
