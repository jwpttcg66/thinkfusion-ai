/** P5-05：发布组合矩阵；受控组合与降级路径。 */
import type { ParticipantView } from './participants/manager';
import { routeParticipants } from './routing';

export interface MatrixCase {
  name: string;
  participants: ParticipantView[];
  scope: 'local' | 'remote' | 'hybrid';
  includeWeb: boolean;
  role: 'answerer' | 'questioner';
  workspace: 'knowledge' | 'engineering' | 'general';
  expectSelected: string[];
}

const p = (id: string, kind: ParticipantView['kind']): ParticipantView => ({
  participantId: id, label: id, kind,
  capabilities: kind === 'web' ? ['knowledge', 'web-research'] : ['reasoning', 'knowledge'],
  available: true
});

export const RELEASE_MATRIX: MatrixCase[] = [
  { name: 'web-only', participants: [p('web', 'web')], scope: 'hybrid', includeWeb: true, role: 'answerer', workspace: 'knowledge', expectSelected: ['web'] },
  { name: 'local-only', participants: [p('local', 'local'), p('cloud', 'cloud')], scope: 'local', includeWeb: false, role: 'answerer', workspace: 'general', expectSelected: ['local'] },
  { name: 'cloud-only', participants: [p('local', 'local'), p('cloud', 'cloud')], scope: 'remote', includeWeb: false, role: 'answerer', workspace: 'general', expectSelected: ['cloud'] },
  { name: 'hybrid', participants: [p('local', 'local'), p('cloud', 'cloud')], scope: 'hybrid', includeWeb: false, role: 'answerer', workspace: 'general', expectSelected: ['local', 'cloud'] },
  { name: 'engineering-web-questioner', participants: [p('web', 'web')], scope: 'hybrid', includeWeb: true, role: 'questioner', workspace: 'engineering', expectSelected: [] }
];

export function runReleaseMatrix(cases: readonly MatrixCase[] = RELEASE_MATRIX): {
  ok: boolean;
  failures: string[];
} {
  const failures: string[] = [];
  for (const item of cases) {
    const result = routeParticipants({
      participants: item.participants,
      modelScope: item.scope,
      includeWeb: item.includeWeb,
      role: item.role,
      workspace: item.workspace
    });
    const got = result.selected.map(x => x.participantId).sort();
    const want = [...item.expectSelected].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${item.name}: ${got.join(',')} != ${want.join(',')}`);
  }
  return { ok: failures.length === 0, failures };
}
