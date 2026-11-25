#!/usr/bin/env python3
import asyncio, base64, json, pathlib, urllib.request
import websockets

list_url = "http://127.0.0.1:9333/json/list"
tabs = json.load(urllib.request.urlopen(list_url))
page = next(t for t in tabs if t.get("type") == "page" and "5173" in (t.get("url") or ""))
WS = page["webSocketDebuggerUrl"]


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

        async def evaluate(expression):
            msg = await call("Runtime.evaluate", {"expression": expression, "returnByValue": True})
            if msg.get("result", {}).get("exceptionDetails"):
                raise RuntimeError(msg["result"]["exceptionDetails"])
            return msg["result"]["result"].get("value")

        await call("Runtime.enable")
        init = await evaluate(
            """(() => ({
          goal: document.querySelector('.task-plan-goal')?.textContent?.trim() || null,
          hasCapsule: !!document.querySelector('.task-plan-capsule'),
          empty: document.body.innerText.includes('探索未至之境')
        }))()"""
        )
        print("INIT", json.dumps(init, ensure_ascii=False))

        if not init or not init.get("goal"):
            opened = await evaluate(
                """(() => {
              const hit = [...document.querySelectorAll('div,button,span,p')].find(n =>
                n.childElementCount === 0 && n.textContent.trim() === '只回答：4+4等于几'
              );
              if (hit) { (hit.closest('button,div') || hit).click(); return 'open-old'; }
              const ta = document.querySelector('textarea');
              if (!ta) return 'no-ta';
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
              setter.call(ta, '只回答：5+5等于几');
              ta.dispatchEvent(new Event('input', { bubbles: true }));
              const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '↑');
              btn?.click();
              return 'sent-new';
            })()"""
            )
            print("ACTION", opened)
            for i in range(30):
                await asyncio.sleep(0.8)
                snap = await evaluate(
                    """(() => {
                  const scroll = document.querySelector('.scroll');
                  const goal = document.querySelector('.task-plan-goal')?.textContent?.trim() || null;
                  const step = document.querySelector('.task-plan-step')?.innerText?.replace(/\\s+/g, ' ').trim() || null;
                  const gap = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight : null;
                  return {
                    goal, step,
                    bad: /正在理解任务目标/.test(goal || ''),
                    workPlan: /工作计划/.test(goal || ''),
                    gap,
                    stickish: gap !== null && gap < 140
                  };
                })()"""
                )
                print(f"T{i}", json.dumps(snap, ensure_ascii=False))
                if snap and snap.get("workPlan") and not snap.get("bad"):
                    break

        final = await evaluate(
            """(() => {
              const scroll = document.querySelector('.scroll');
              const goal = document.querySelector('.task-plan-goal')?.textContent?.trim() || null;
              const step = document.querySelector('.task-plan-step')?.innerText?.replace(/\\s+/g, ' ').trim() || null;
              const nm = document.querySelector('.task-plan-nm')?.textContent?.trim() || null;
              const gap = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight : null;
              return {
                goal, step, nm,
                bad: /正在理解任务目标/.test(goal || ''),
                workPlan: /工作计划/.test(goal || ''),
                inDock: !!document.querySelector('.dock .task-plan-capsule'),
                liveBottom: !!document.querySelector('.conv-live-bottom'),
                gap,
                stickish: gap !== null && gap < 160
              };
            })()"""
        )
        print("FINAL", json.dumps(final, ensure_ascii=False))
        shot = await call("Page.captureScreenshot", {"format": "png", "fromSurface": True})
        out = pathlib.Path(__file__).resolve().parents[1] / "docs/ui/task-plan-capsule-fixed.png"
        out.write_bytes(base64.b64decode(shot["result"]["data"]))
        print("SHOT", out)
        if not final or not final.get("workPlan") or final.get("bad") or not final.get("inDock"):
            raise SystemExit(2)


asyncio.run(main())
