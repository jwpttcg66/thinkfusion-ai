/** A-04：协作模式设置视图与切换；active 必须过门禁。 */
import { CollaborationModeStore, type CollaborationMode } from './mode';
import { evaluateActiveGate } from './gate';
import type { ShadowMetricsStore } from './metrics-store';

export interface CollaborationSettingsView {
  mode: CollaborationMode;
  gate: { ok: boolean; reasons: string[] };
  metrics: ReturnType<ShadowMetricsStore['get']>;
}

export class CollaborationSettings {
  constructor(
    private readonly modes: CollaborationModeStore,
    private readonly metrics: ShadowMetricsStore
  ) {}

  get(): CollaborationSettingsView {
    const metrics = this.metrics.get();
    return { mode: this.modes.get(), gate: evaluateActiveGate(metrics), metrics };
  }

  set(mode: unknown): CollaborationSettingsView {
    const metrics = this.metrics.get();
    this.modes.setGated(mode, metrics);
    return this.get();
  }
}
