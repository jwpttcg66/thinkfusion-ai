# Task Plan Capsule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Dock a centered task-plan capsule above the composer (goal + step + n/m + user-message tick rail); stop live progress from inserting into the scroll body.

**Architecture:** New `TaskPlanCapsule` in renderer, mounted in `.dock` before `TaskInput`. Progress from `deriveProgress`. Tick rail projects `role=user` messages only; jumps to `data-user-msg` anchors in ConversationView. Remove `conv-live-bottom` and scroll-area `ProgressPanel`.

**Tech Stack:** React + existing App/ConversationView/progress.ts + CSS.

## File map

| File | Role |
|------|------|
| `src/renderer/src/components/TaskPlanCapsule.tsx` | Capsule UI + tick rail |
| `src/renderer/src/style.css` | Capsule + tick styles |
| `src/renderer/src/App.tsx` | Mount in dock; remove scroll ProgressPanel |
| `src/renderer/src/components/ConversationView.tsx` | User-msg anchors; remove conv-live-bottom |
| `src/shared/progress.ts` | Reuse as-is for n/m |

### Task 1: TaskPlanCapsule + styles

- [ ] Create component (goal, progress row, ticks)
- [ ] Add CSS under dock

### Task 2: Wire App dock + cleanup ProgressPanel

- [ ] Mount capsule with goal/events/messages/status
- [ ] Remove ProgressPanel from chat feed area

### Task 3: ConversationView anchors + remove live-bottom

- [ ] `data-user-msg` on user prompts
- [ ] Remove `conv-live-bottom` block

### Task 4: Verify in running app

- [ ] Screenshot: capsule above input; ticks jump; body stable
