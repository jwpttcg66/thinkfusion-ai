/**
 * What the sidebar calls you.
 *
 * This used to be `os.userInfo().username`, with `os.hostname()` as the tooltip,
 * and that was wrong for a reason that has nothing to do with taste: the app has
 * no account, so it was putting the operating system's login name — and a
 * machine name that on macOS is usually derived from it — on screen. From there
 * it went into screenshots, screen recordings and anything a person shared. A
 * product that displays a name it was never given is a product that leaks one.
 *
 * So the name is now chosen by the person using the app, defaulting to 本机用户.
 * No OS call, nothing to leak, and the label stops pretending to be an account.
 * The second line describes the platform rather than the machine, for the same
 * reason: "这台 Mac" is true and identifies nobody.
 *
 * The rule this encodes is not "hide this one string" — it is that the app never
 * displays a value the operating system handed it about its owner. See the
 * project's bottom-line rules for the literal-string half of it.
 */

export const DEFAULT_DISPLAY_NAME = '本机用户';

/** Long enough for a real name, short enough for a 44px row. */
export const MAX_DISPLAY_NAME_LENGTH = 16;

/** One character for the avatar square. Works for CJK as well as Latin. */
export function initialOf(name: string): string {
  const first = [...name.trim()][0] ?? '';
  return first ? first.toUpperCase() : '·';
}

export interface DisplayNameCheck {
  ok: boolean;
  name?: string;
  error?: string;
}

/**
 * Validate a typed display name.
 *
 * Rejections are sentences because they are shown next to the input that was
 * rejected, not logged. Control characters are refused rather than stripped:
 * silently rewriting what someone typed is how a name ends up not being the one
 * they asked for.
 */
export function normalizeDisplayName(raw: unknown): DisplayNameCheck {
  if (typeof raw !== 'string') return { ok: false, error: '名字必须是一段文字' };
  const name = raw.trim();
  if (!name) return { ok: false, error: '名字不能是空的' };
  if ([...name].length > MAX_DISPLAY_NAME_LENGTH) {
    return { ok: false, error: `名字最多 ${MAX_DISPLAY_NAME_LENGTH} 个字` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: '名字里不能有换行或控制字符' };
  return { ok: true, name };
}

/** The line under the name. Platform, not machine — see the note above. */
export function deviceLabel(platform: string): string {
  if (platform === 'darwin') return '这台 Mac';
  if (platform === 'win32') return '这台 Windows';
  if (platform === 'linux') return '这台 Linux';
  return '这台电脑';
}
