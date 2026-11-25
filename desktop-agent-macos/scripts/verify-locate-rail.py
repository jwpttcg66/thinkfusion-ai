#!/usr/bin/env python3
"""真机验收：侧边短杠在整段正文，不在工作计划胶囊。"""
import asyncio, base64, json, pathlib, urllib.request
import websockets

tabs = json.load(urllib.request.urlopen("http://127.0.0.1:9333/json/list"))
page = next(t for t in tabs if t.get("type") == "page" and "5173" in (t.get("url") or ""))
WS = page["webSocketDebuggerUrl"]
OUT = pathlib.Path(__file__).resolve().parents[1] / "docs/ui"


async def main():
    async with websockets.connect(WS, max_size=20_000_000) as ws:
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

        async def evaluate(expression, await_promise=False):
            msg = await call(
                "Runtime.evaluate",
                {
                    "expression": expression,
                    "returnByValue": True,
                    "awaitPromise": await_promise,
                },
            )
            if msg.get("result", {}).get("exceptionDetails"):
                raise RuntimeError(json.dumps(msg["result"]["exceptionDetails"]))
            return msg["result"]["result"].get("value")

        async def shot(name):
            data = await call("Page.captureScreenshot", {"format": "png", "fromSurface": True})
            path = OUT / name
            path.write_bytes(base64.b64decode(data["result"]["data"]))
            print("SHOT", path.name, path.stat().st_size)
            return path

        await call("Runtime.enable")
        await call("Page.reload", {"ignoreCache": True})
        await asyncio.sleep(2.0)

        opened = await evaluate(
            """(() => {
              const labels = [...document.querySelectorAll('div,button,span,p')]
                .filter(n => n.childElementCount === 0)
                .map(n => n.textContent.trim())
                .filter(Boolean);
              const pick = labels.find(t => t.startsWith('只回答')) || labels.find(t => /\\+/.test(t) && t.length < 40);
              if (!pick) return { ok: false, reason: 'no-session' };
              const hit = [...document.querySelectorAll('div,button,span,p')].find(n =>
                n.childElementCount === 0 && n.textContent.trim() === pick
              );
              (hit.closest('button,div') || hit).click();
              return { ok: true, pick };
            })()"""
        )
        print("OPEN", json.dumps(opened, ensure_ascii=False))
        await asyncio.sleep(1.5)

        snap = await evaluate(
            """(() => {
              const rail = document.querySelector('.user-msg-locate-rail');
              const spine = document.querySelector('.user-msg-locate-spine');
              const ticks = [...document.querySelectorAll('.user-msg-locate-hit')];
              const capsuleTicks = document.querySelectorAll(
                '.task-plan-capsule .user-msg-locate-hit, .task-plan-capsule .task-plan-tick, .dock .user-msg-locate-hit'
              );
              const capsule = document.querySelector('.task-plan-capsule');
              const dock = document.querySelector('.dock');
              const scroll = document.querySelector('.scroll');
              const wrap = document.querySelector('.scroll-with-rail');
              const railRect = rail?.getBoundingClientRect();
              const scrollRect = scroll?.getBoundingClientRect();
              const dockRect = dock?.getBoundingClientRect();
              const capsuleRect = capsule?.getBoundingClientRect();
              return {
                hasRail: !!rail,
                hasSpine: !!spine,
                hasBars: document.querySelectorAll('.user-msg-locate-hit-bar').length > 0,
                transparentRail: (() => {
                  if (!rail) return false;
                  const bg = getComputedStyle(rail).backgroundColor.replace(/\\s+/g, '');
                  return !bg || bg === 'rgba(0,0,0,0)' || bg === 'transparent';
                })(),
                tickCount: ticks.length,
                capsuleTickCount: capsuleTicks.length,
                inWrap: !!(wrap && rail && wrap.contains(rail)),
                inCapsule: !!(capsule && rail && capsule.contains(rail)),
                inDock: !!(dock && rail && dock.contains(rail)),
                railTop: railRect && Math.round(railRect.top),
                railHeight: railRect && Math.round(railRect.height),
                scrollTop: scrollRect && Math.round(scrollRect.top),
                scrollHeight: scrollRect && Math.round(scrollRect.height),
                dockTop: dockRect && Math.round(dockRect.top),
                capsuleTop: capsuleRect && Math.round(capsuleRect.top),
                spansBody: !!(railRect && scrollRect &&
                  Math.abs(railRect.top - scrollRect.top) < 40 &&
                  railRect.height >= scrollRect.height * 0.6),
                offsetLeft: (() => {
                  const rail = document.querySelector('.user-msg-locate-rail');
                  const wrap = document.querySelector('.scroll-with-rail');
                  if (!rail || !wrap) return null;
                  return Math.round(rail.getBoundingClientRect().left - wrap.getBoundingClientRect().left);
                })(),
                aboveDock: !!(railRect && dockRect && railRect.bottom <= dockRect.top + 8),
                active: ticks.some(t => t.classList.contains('is-active')),
                goal: document.querySelector('.task-plan-goal')?.textContent?.trim() || null
              };
            })()"""
        )
        print("SNAP", json.dumps(snap, ensure_ascii=False, indent=2))
        await shot("locate-rail-body.png")

        # 先滚到最底，再点第一条短杠，确认正文会跳上去
        await evaluate(
            """(() => {
              const scroll = document.querySelector('.scroll');
              if (scroll) scroll.scrollTop = scroll.scrollHeight;
              return scroll?.scrollTop ?? -1;
            })()"""
        )
        await asyncio.sleep(0.3)
        jump = await evaluate(
            """(() => {
              const scroll = document.querySelector('.scroll');
              const before = scroll?.scrollTop ?? -1;
              const tick = document.querySelector('.user-msg-locate-hit');
              tick?.click();
              return new Promise(resolve => {
                setTimeout(() => {
                  const node = document.querySelector('[data-user-msg]');
                  const nt = node?.getBoundingClientRect().top ?? null;
                  const st = scroll?.getBoundingClientRect().top ?? null;
                  const after = scroll?.scrollTop ?? -1;
                  resolve({
                    before,
                    after,
                    moved: Math.abs(after - before) > 2,
                    visible: nt !== null && st !== null && nt >= st - 8 && nt < st + (scroll?.clientHeight || 0)
                  });
                }, 600);
              });
            })()""",
            await_promise=True,
        )
        print("JUMP", json.dumps(jump, ensure_ascii=False))
        await shot("locate-rail-after-jump.png")

        ok = (
            snap
            and snap.get("hasRail")
            and not snap.get("hasSpine")
            and snap.get("hasBars")
            and snap.get("transparentRail")
            and snap.get("tickCount", 0) > 0
            and snap.get("capsuleTickCount", 0) == 0
            and snap.get("inWrap")
            and not snap.get("inCapsule")
            and not snap.get("inDock")
            and snap.get("spansBody")
            and snap.get("aboveDock")
            and snap.get("offsetLeft") is not None
            and abs(snap.get("offsetLeft")) <= 2
            and jump
            and (jump.get("moved") or jump.get("visible"))
        )
        print("PASS" if ok else "FAIL")
        raise SystemExit(0 if ok else 2)


asyncio.run(main())
