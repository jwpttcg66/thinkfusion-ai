#!/usr/bin/env python3
import asyncio, base64, json, pathlib, time, urllib.request
import websockets

OUT = pathlib.Path(__file__).resolve().parents[1] / "docs/ui"


def wait_page():
    for _ in range(30):
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
        await asyncio.sleep(1.0)
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
        await asyncio.sleep(1.2)

        snap = await evaluate(
            """(() => {
              const rail = document.querySelector('.user-msg-locate-rail');
              const dashes = document.querySelectorAll('.user-msg-locate-dash');
              const ticks = document.querySelectorAll('.user-msg-locate-tick');
              const viewport = document.querySelector('.user-msg-locate-dash.is-viewport');
              const cs = rail ? getComputedStyle(rail) : null;
              const railRect = rail?.getBoundingClientRect();
              const scrollRect = document.querySelector('.scroll')?.getBoundingClientRect();
              return {
                hasRail: !!rail,
                dashCount: dashes.length,
                tickCount: ticks.length,
                hasViewport: !!viewport,
                bg: cs?.backgroundColor || null,
                railHeight: railRect && Math.round(railRect.height),
                scrollHeight: scrollRect && Math.round(scrollRect.height),
                darkRail: !!cs && cs.backgroundColor.includes('30, 30, 30') || (cs && /rgb\\(30,\\s*30,\\s*30\\)/.test(cs.backgroundColor)),
                inDock: !!document.querySelector('.dock .user-msg-locate-rail'),
                inCapsule: !!document.querySelector('.task-plan-capsule .user-msg-locate-dash')
              };
            })()"""
        )
        # fix darkRail detection - #1e1e1e = rgb(30, 30, 30)
        print("SNAP", json.dumps(snap, ensure_ascii=False, indent=2))
        shot = await call("Page.captureScreenshot", {"format": "png", "fromSurface": True})
        path = OUT / "locate-rail-style.png"
        path.write_bytes(base64.b64decode(shot["result"]["data"]))
        print("SHOT", path)

        # clip rail only
        clip = await evaluate(
            """(() => {
              const rail = document.querySelector('.user-msg-locate-rail');
              if (!rail) return null;
              const r = rail.getBoundingClientRect();
              const dpr = window.devicePixelRatio || 1;
              return { x: r.x, y: r.y, width: Math.max(r.width, 1), height: Math.max(r.height, 1), dpr };
            })()"""
        )
        if clip:
            # capture full then we already have full shot; also try clip via CDP
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

        bg = snap.get("bg") or ""
        dark = "30, 30, 30" in bg or "30,30,30" in bg.replace(" ", "")
        ok = (
            snap
            and snap.get("hasRail")
            and snap.get("dashCount", 0) >= 18
            and snap.get("tickCount", 0) >= 1
            and snap.get("hasViewport")
            and dark
            and not snap.get("inDock")
            and not snap.get("inCapsule")
        )
        print("PASS" if ok else "FAIL", "dark", dark, "bg", bg)
        raise SystemExit(0 if ok else 2)


asyncio.run(main())
