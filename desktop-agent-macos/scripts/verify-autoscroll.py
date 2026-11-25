#!/usr/bin/env python3
"""发送一问，流式期间反复测 .scroll 的 gap，并截图证明自动下拉。"""
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

        async def evaluate(expression):
            msg = await call("Runtime.evaluate", {"expression": expression, "returnByValue": True})
            if msg.get("result", {}).get("exceptionDetails"):
                raise RuntimeError(json.dumps(msg["result"]["exceptionDetails"]))
            return msg["result"]["result"].get("value")

        async def shot(name):
            data = await call("Page.captureScreenshot", {"format": "png", "fromSurface": True})
            path = OUT / name
            path.write_bytes(base64.b64decode(data["result"]["data"]))
            print("SHOT", path.name, path.stat().st_size)

        await call("Runtime.enable")
        # 新对话，避免旧会话高度干扰
        await evaluate(
            """(() => {
              const btn = [...document.querySelectorAll('button')].find(b => /新对话/.test(b.textContent||''));
              btn?.click();
              return !!btn;
            })()"""
        )
        await asyncio.sleep(0.8)
        sent = await evaluate(
            """(() => {
              const ta = document.querySelector('textarea');
              if (!ta) return 'no-ta';
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
              setter.call(ta, '只回答：7+7等于几，并写三句解释');
              ta.dispatchEvent(new Event('input', { bubbles: true }));
              const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '↑');
              btn?.click();
              return 'sent';
            })()"""
        )
        print("SENT", sent)

        samples = []
        mid_shot = False
        for i in range(40):
            await asyncio.sleep(0.5)
            snap = await evaluate(
                """(() => {
                  const scroll = document.querySelector('.scroll');
                  if (!scroll) return null;
                  const gap = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
                  const busy = !!document.body.innerText.match(/停止等待|思考中|提问中|写作中|汇总中/);
                  const status = [...document.querySelectorAll('.conv-status, [class*=\"conv-status\"]')]
                    .map(n => n.textContent.trim()).slice(0,3);
                  const goal = document.querySelector('.task-plan-goal')?.textContent?.trim() || null;
                  return {
                    gap: Math.round(gap),
                    scrollTop: Math.round(scroll.scrollTop),
                    scrollHeight: Math.round(scroll.scrollHeight),
                    clientHeight: Math.round(scroll.clientHeight),
                    busy,
                    stickish: gap < 160,
                    goal,
                    status
                  };
                })()"""
            )
            if not snap:
                continue
            samples.append(snap)
            print(f"T{i}", json.dumps(snap, ensure_ascii=False))
            if snap.get("busy") and snap.get("scrollHeight", 0) > snap.get("clientHeight", 0) + 80 and not mid_shot:
                await shot("autoscroll-mid.png")
                mid_shot = True
            # 结束后再采几帧
            if not snap.get("busy") and i > 8 and snap.get("goal"):
                await asyncio.sleep(0.6)
                break

        await shot("autoscroll-end.png")
        busy_samples = [s for s in samples if s.get("busy") and s.get("scrollHeight", 0) > s.get("clientHeight", 0) + 40]
        if not busy_samples:
            # 任务太快也可能；至少要求最终贴底
            last = samples[-1] if samples else {}
            ok = last.get("stickish") is True
            print("FINAL_ONLY", last, "ok", ok)
            raise SystemExit(0 if ok else 2)

        bad = [s for s in busy_samples if not s.get("stickish")]
        print("BUSY_COUNT", len(busy_samples), "BAD", len(bad))
        if bad:
            print("BAD_SAMPLES", json.dumps(bad[:5], ensure_ascii=False))
            raise SystemExit(2)
        print("PASS autoscroll during busy")


asyncio.run(main())
