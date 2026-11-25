export type ShortcutScope = 'global' | 'spreadsheet';

export interface ShortcutKeyCombo {
  ctrlOrCmd?: boolean;
  shift?: boolean;
  alt?: boolean;
  key: string;
}

export interface ShortcutDefinition {
  id: string;
  scope: ShortcutScope;
  combo: ShortcutKeyCombo;
  /** Optional secondary display-only or runtime alias (e.g., Ctrl+Y for Redo) */
  displayLabel?: string;
  title: string;
  description: string;
  /** When true, shortcut can fire even while focus is inside an editable input/textarea */
  allowInEditable?: boolean;
  /** Informational entry shown in Shortcuts Help; handled natively by widget */
  informationalOnly?: boolean;
}

export interface KeyboardEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
}

export interface EventTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

export interface PlatformNavigatorLike {
  platform?: string;
  userAgent?: string;
  userAgentData?: {platform?: string};
}

export function isMacPlatform(nav?: PlatformNavigatorLike | null): boolean {
  const source =
    nav ??
    (typeof navigator !== 'undefined'
      ? (navigator as unknown as PlatformNavigatorLike)
      : null);
  if (!source) return false;
  const plat = (
    source.userAgentData?.platform ??
    source.platform ??
    source.userAgent ??
    ''
  ).toLowerCase();
  return plat.includes('mac') || plat.includes('iphone') || plat.includes('ipad');
}

export function isEditableEventTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as EventTargetLike;
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const type = el.getAttribute?.('type')?.toLowerCase();
    // Non-text inputs such as checkboxes/buttons do not capture typing shortcuts like Ctrl+Z
    if (
      tag === 'INPUT' &&
      (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit')
    ) {
      return false;
    }
    return true;
  }
  if (el.isContentEditable) return true;
  const ceAttr = el.getAttribute?.('contenteditable');
  if (ceAttr === '' || ceAttr === 'true' || ceAttr === 'plaintext-only') {
    return true;
  }
  if (el.closest?.('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')) {
    return true;
  }
  return false;
}

export function normalizeShortcutSignature(
  combo: ShortcutKeyCombo
): string {
  const mods = [
    combo.ctrlOrCmd ? 'mod' : '',
    combo.shift ? 'shift' : '',
    combo.alt ? 'alt' : '',
  ]
    .filter(Boolean)
    .join('+');
  const normalizedKey =
    combo.key.length === 1 ? combo.key.toLowerCase() : combo.key;
  return mods ? `${mods}+${normalizedKey}` : normalizedKey;
}

export function detectShortcutConflicts(
  shortcuts: readonly ShortcutDefinition[]
): Array<{scope: ShortcutScope; signature: string; ids: string[]}> {
  const byBucket = new Map<string, {scope: ShortcutScope; signature: string; ids: string[]}>();
  for (const sc of shortcuts) {
    if (sc.informationalOnly) continue;
    const signature = normalizeShortcutSignature(sc.combo);
    const bucketKey = `${sc.scope}::${signature}`;
    const existing = byBucket.get(bucketKey);
    if (existing) {
      existing.ids.push(sc.id);
    } else {
      byBucket.set(bucketKey, {scope: sc.scope, signature, ids: [sc.id]});
    }
  }
  return [...byBucket.values()].filter((entry) => entry.ids.length > 1);
}

export function matchesShortcut(
  event: KeyboardEventLike,
  combo: ShortcutKeyCombo
): boolean {
  if (!event.key) return false;

  const hasCtrlOrCmd = Boolean(event.ctrlKey || event.metaKey);
  if (Boolean(combo.ctrlOrCmd) !== hasCtrlOrCmd) return false;
  if (Boolean(combo.alt) !== Boolean(event.altKey)) return false;

  // On many layouts '?' is produced with Shift+/, so key equality '?' ignores shiftKey flag
  if (combo.key === '?') {
    return event.key === '?' && !hasCtrlOrCmd && !event.altKey;
  }

  if (Boolean(combo.shift) !== Boolean(event.shiftKey)) return false;

  if (combo.key.length === 1) {
    return event.key.toLowerCase() === combo.key.toLowerCase();
  }
  return event.key === combo.key;
}

export function formatShortcutTokens(
  combo: ShortcutKeyCombo,
  mac = isMacPlatform()
): string[] {
  const tokens: string[] = [];
  if (combo.ctrlOrCmd) tokens.push(mac ? '⌘' : 'Ctrl');
  if (combo.shift) tokens.push(mac ? '⇧' : 'Shift');
  if (combo.alt) tokens.push(mac ? '⌥' : 'Alt');

  const keyLabel =
    combo.key === 'Escape'
      ? 'Esc'
      : combo.key.length === 1
        ? combo.key.toUpperCase()
        : combo.key;
  tokens.push(keyLabel);
  return tokens;
}

export function formatShortcutString(
  combo: ShortcutKeyCombo,
  mac = isMacPlatform()
): string {
  const tokens = formatShortcutTokens(combo, mac);
  return mac ? tokens.join('') : tokens.join('+');
}

export const APP_SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: 'palette.open',
    scope: 'global',
    combo: {ctrlOrCmd: true, key: 'k'},
    title: 'Open Command Palette',
    description: 'Search and run workspace, column, sheet, chart, and inspector commands.',
    allowInEditable: true,
  },
  {
    id: 'search.focus',
    scope: 'global',
    combo: {ctrlOrCmd: true, key: 'f'},
    title: 'Focus table search',
    description: 'Jump directly to the spreadsheet row filter input.',
    allowInEditable: false,
  },
  {
    id: 'history.undo',
    scope: 'global',
    combo: {ctrlOrCmd: true, key: 'z'},
    title: 'Undo workbook edit',
    description: 'Revert the last spreadsheet edit or structural change outside text inputs.',
    allowInEditable: false,
  },
  {
    id: 'history.redo',
    scope: 'global',
    combo: {ctrlOrCmd: true, shift: true, key: 'z'},
    title: 'Redo workbook edit',
    description: 'Reapply the last undone workbook change.',
    allowInEditable: false,
  },
  {
    id: 'history.redoAlt',
    scope: 'global',
    combo: {ctrlOrCmd: true, key: 'y'},
    title: 'Redo (alternate)',
    description: 'Alternate shortcut to reapply the last undone workbook change.',
    allowInEditable: false,
  },
  {
    id: 'help.shortcuts',
    scope: 'global',
    combo: {key: '?'},
    title: 'Keyboard Shortcuts Help',
    description: 'Open this reference dialog when focus is outside text inputs.',
    allowInEditable: false,
  },
  {
    id: 'workbook.saveAs',
    scope: 'global',
    combo: {ctrlOrCmd: true, shift: true, key: 's'},
    title: 'Save As…',
    description: 'Choose export filename, format (.xlsx, .csv, .tsv), and scope.',
    allowInEditable: false,
  },
  {
    id: 'overlay.close',
    scope: 'global',
    combo: {key: 'Escape'},
    title: 'Close active overlay',
    description: 'Dismiss the topmost open palette, dialog, manager popover, or mobile inspector.',
    allowInEditable: true,
  },
  // Spreadsheet grid shortcuts (handled by SpreadsheetGrid & WorkspaceSplitter)
  {
    id: 'grid.navigate',
    scope: 'spreadsheet',
    combo: {key: 'Arrow keys'},
    displayLabel: 'Arrow keys',
    title: 'Navigate cells',
    description: 'Move cell focus across rows and visible columns (respects pinned order).',
    informationalOnly: true,
  },
  {
    id: 'grid.edit',
    scope: 'spreadsheet',
    combo: {key: 'Enter / F2'},
    displayLabel: 'Enter or F2',
    title: 'Edit selected cell',
    description: 'Enter inline edit mode on the focused cell (or double-click).',
    informationalOnly: true,
  },
  {
    id: 'grid.commit',
    scope: 'spreadsheet',
    combo: {key: 'Enter / Tab'},
    displayLabel: 'Enter / Tab',
    title: 'Commit edit and move',
    description: 'Save cell edit and advance down (Enter) or right (Tab).',
    informationalOnly: true,
  },
  {
    id: 'grid.cancelEdit',
    scope: 'spreadsheet',
    combo: {key: 'Escape'},
    displayLabel: 'Esc',
    title: 'Cancel cell edit',
    description: 'Discard unsaved edits in the active cell or column rename input.',
    informationalOnly: true,
  },
];

export type ShortcutDispatchOutcome =
  | {handled: true; shortcutId: string}
  | {handled: false};

export function dispatchKeyboardShortcut(
  event: KeyboardEventLike,
  target: unknown,
  handlers: Record<string, () => boolean | void>
): ShortcutDispatchOutcome {
  if (event.defaultPrevented) return {handled: false};
  const isEditable = isEditableEventTarget(target);

  for (const def of APP_SHORTCUTS) {
    if (def.informationalOnly) continue;
    if (!matchesShortcut(event, def.combo)) continue;
    if (isEditable && !def.allowInEditable) {
      return {handled: false};
    }
    const handler = handlers[def.id];
    if (!handler) continue;
    const res = handler();
    if (res !== false) {
      return {handled: true, shortcutId: def.id};
    }
  }

  return {handled: false};
}
