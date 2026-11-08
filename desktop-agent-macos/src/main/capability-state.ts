/**
 * 开关的一份进程内真相。
 *
 * Runtime 是独立进程，读不到主进程的 userData，所以「哪些插件被停用了」
 * 必须随每次 `task.run` 送过去。这里同时把它同步给主进程自己的注册表：
 * 两个宿主各守一道，不存在「界面显示停用、主进程照样保存」的漏口。
 */

import { normalizeDisabled } from '../shared/capabilities';
import { mainCapabilities } from './capabilities';

let disabled: string[] = [];

export function disabledCapabilities(): readonly string[] {
  return disabled;
}

export function setDisabledCapabilities(raw: unknown): string[] {
  disabled = normalizeDisabled(raw);
  mainCapabilities.setDisabled(disabled);
  return [...disabled];
}
