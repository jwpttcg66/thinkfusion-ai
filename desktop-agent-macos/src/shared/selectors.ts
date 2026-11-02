/**
 * The roles a page has to expose before the app can drive it.
 *
 * These live in shared/ because three separate places need to agree on the
 * spelling: the built-in profile in `deepseek-adapter.ts`, the discovery script
 * that runs inside the page, and the persisted file of learned selectors. When
 * the list was a bare object literal, a typo in the discovery script produced a
 * role nobody read and a repair that silently did nothing.
 */
export const SELECTOR_ROLES = [
  'input',
  'sendButton',
  'stopButton',
  'newChatButton',
  'assistant',
  'passwordField'
] as const;

export type SelectorRole = (typeof SELECTOR_ROLES)[number];

/**
 * Ordered CSS selectors, most specific first.
 *
 * Order is the whole mechanism: the probe takes the first list entry that
 * matches something visible, so a learned selector appended at the end only
 * gets a turn when every built-in one has stopped matching.
 */
export type SelectorProfile = Record<SelectorRole, string[]>;

/**
 * What the in-page discovery returned for one role.
 *
 * `hits` is the number of visible elements the selector matches right now.
 * A selector that matches nothing after being built from a live element means
 * the element was removed between the two steps, so the pair is discarded
 * rather than persisted.
 */
export interface DiscoveredRole {
  selector: string;
  hits: number;
}

export interface DiscoveredSelectors {
  url: string;
  roles: Record<SelectorRole, DiscoveredRole | null>;
}

/** One role that a repair pass decided to keep, with the evidence for it. */
export interface LearnedRole {
  role: SelectorRole;
  selector: string;
  /** What changed, in the user's terms — shown next to the button. */
  note: string;
}

/**
 * The result of one 「更新样式」 press.
 *
 * `failed` is not an error: it is the list of roles the page still does not
 * expose, which is what tells a person the difference between "the site changed
 * and I fixed it" and "you are not logged in yet".
 */
export interface LearnSelectorsReport {
  sourceId: string;
  learned: LearnedRole[];
  /** Roles that already worked, so nothing needed to be learned for them. */
  intact: SelectorRole[];
  failed: SelectorRole[];
  probe: {
    hasInput: boolean;
    hasSendButton: boolean;
    messageCount: number;
    viewportWidth: number;
  };
  /** One sentence for the status bar. */
  message: string;
}

/**
 * The roles a repair pass may touch, and the probe field that proves it worked.
 *
 * Only three. They are the ones with a measurable outcome: a repair that cannot
 * be confirmed by the next probe is a guess, and persisting a guess is how a
 * self-healing feature turns into a self-breaking one. `stopButton` is
 * deliberately absent — its signal is only true while the page is generating, so
 * "it matched" and "it is correct" cannot be checked at the same moment.
 */
export const REPAIRABLE_ROLES = ['input', 'sendButton', 'assistant'] as const;
export type RepairableRole = (typeof REPAIRABLE_ROLES)[number];

/** What the current profile can already see, one boolean per repairable role. */
export type WorkingRoles = Record<RepairableRole, boolean>;

export interface RepairProposal {
  /** Learned selectors worth trying, one per role that is currently broken. */
  candidate: Partial<Record<SelectorRole, string[]>>;
  intact: RepairableRole[];
  failed: RepairableRole[];
}

/**
 * Decide which roles need a learned selector at all.
 *
 * A role that already works is never proposed: appending a second selector for
 * it could only change which node gets picked, and "it worked before" is worth
 * more than "a heuristic liked this one better".
 */
export function proposeRepairs(
  working: WorkingRoles,
  discovered: Partial<Record<SelectorRole, { selector: string; hits: number } | null>>
): RepairProposal {
  const candidate: Partial<Record<SelectorRole, string[]>> = {};
  const intact: RepairableRole[] = [];
  const failed: RepairableRole[] = [];

  for (const role of REPAIRABLE_ROLES) {
    if (working[role]) {
      intact.push(role);
      continue;
    }
    const found = discovered[role];
    // `hits < 1` means the element vanished between being read and being
    // described — a selector that matches nothing now will match nothing later.
    if (!found || found.hits < 1 || found.selector.length === 0) {
      failed.push(role);
      continue;
    }
    candidate[role] = [found.selector];
  }

  return { candidate, intact, failed };
}

/**
 * Keep only the proposals the page actually confirms.
 *
 * `after` is a probe run with the candidate merged in — the same probe the
 * question path uses, so this is a test of the real thing rather than of the
 * discovery script's own opinion.
 */
export function confirmRepairs(
  candidate: Partial<Record<SelectorRole, string[]>>,
  after: { hasInput: boolean; hasSendButton: boolean; messageCount: number }
): { confirmed: Partial<Record<SelectorRole, string[]>>; learned: RepairableRole[]; failed: RepairableRole[] } {
  const confirmed: Partial<Record<SelectorRole, string[]>> = {};
  const learned: RepairableRole[] = [];
  const failed: RepairableRole[] = [];

  for (const [role, list] of Object.entries(candidate) as Array<[RepairableRole, string[]]>) {
    const repaired =
      role === 'input' ? after.hasInput : role === 'sendButton' ? after.hasSendButton : after.messageCount > 0;
    if (!repaired || !list[0]) {
      failed.push(role);
      continue;
    }
    confirmed[role] = list;
    learned.push(role);
  }

  return { confirmed, learned, failed };
}
