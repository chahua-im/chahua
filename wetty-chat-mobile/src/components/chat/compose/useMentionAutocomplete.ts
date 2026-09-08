import { useCallback, useRef, useState } from 'react';
import { getMembers, type MemberResponse } from '@/api/group';
import { findCodeRegions } from '@/utils/markdown/codeRegions';

export interface MentionEntry {
  uid: number;
  username: string;
  /** Start index of "@username" in the textarea text */
  start: number;
  /** End index (exclusive) of "@username" in the textarea text */
  end: number;
}

export interface MentionState {
  isOpen: boolean;
  results: MemberResponse[];
  selectedIndex: number;
  loading: boolean;
  query: string;
}

interface UseMentionAutocompleteResult {
  mentionState: MentionState;
  mentionEntries: MentionEntry[];
  selectMention: (member: MemberResponse) => void;
  handleKeyDown: (event: KeyboardEvent) => boolean;
  /** Convert display text to wire format before sending */
  toWireFormat: (text: string) => string;
  /** Clear all mention entries (call after send) */
  clearMentions: () => void;
  /** Notify the hook of cursor/text changes */
  onTextChange: (newText: string) => void;
}

/**
 * Detects an `@` trigger: scans backwards from the cursor to find `@`
 * preceded by whitespace or at position 0. Returns the query string after `@`,
 * or null if no trigger is active.
 */
function detectMentionTrigger(text: string, cursorPos: number): { query: string; triggerStart: number } | null {
  if (cursorPos <= 0) return null;

  // Walk backwards from cursor to find `@`
  let i = cursorPos - 1;
  while (i >= 0) {
    const ch = text[i];
    // Stop on whitespace or newline — no `@` found in this "word"
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') return null;
    if (ch === '@') {
      // `@` must be at start of text or preceded by whitespace/newline
      if (i === 0 || /\s/.test(text[i - 1])) {
        return { query: text.slice(i + 1, cursorPos), triggerStart: i };
      }
      return null;
    }
    i--;
  }
  return null;
}

/**
 * Re-anchors mention entries (stored as absolute offsets into `previousText`)
 * after the text has been edited into `nextText`.
 *
 * Edits that happen entirely before or after an entry shift its offsets;
 * edits that touch the mention's own span drop it — unless the mention text
 * survives verbatim inside the rewritten middle (e.g. wrapping `*@alice*` in
 * emphasis), in which case the entry is re-located by searching for the text.
 */
export function relocateMentionEntries(
  previousText: string,
  entries: MentionEntry[],
  nextText: string,
): MentionEntry[] {
  if (entries.length === 0 || previousText === nextText) return entries;

  const maxAnchor = Math.min(previousText.length, nextText.length);
  let prefix = 0;
  while (prefix < maxAnchor && previousText[prefix] === nextText[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < maxAnchor - prefix &&
    previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const changeStart = prefix;
  const changeEnd = previousText.length - suffix;
  const delta = nextText.length - previousText.length;
  const changedNew = nextText.slice(changeStart, nextText.length - suffix);

  const relocated: MentionEntry[] = [];
  for (const entry of entries) {
    if (entry.end <= changeStart) {
      relocated.push(entry);
      continue;
    }
    if (entry.start >= changeEnd) {
      relocated.push({ ...entry, start: entry.start + delta, end: entry.end + delta });
      continue;
    }
    if (entry.start >= changeStart && entry.end <= changeEnd) {
      const raw = previousText.slice(entry.start, entry.end);
      if (raw === `@${entry.username}`) {
        const hint = entry.start - changeStart;
        const found = indexOfClosestSubstring(changedNew, raw, hint);
        if (found !== -1) {
          relocated.push({ ...entry, start: changeStart + found, end: changeStart + found + raw.length });
          continue;
        }
      }
    }
  }
  return relocated;
}

function indexOfClosestSubstring(haystack: string, needle: string, hint: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const distance = Math.abs(index - hint);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
    index = haystack.indexOf(needle, index + 1);
  }
  return best;
}

/**
 * Replaces every valid mention entry in display text with its `@[uid:N]` wire
 * macro. Mentions whose text no longer matches the entry (edited away), or
 * that fall inside a code region, are left verbatim — a code mention renders
 * as plain text and must never trigger a backend reminder.
 */
export function mentionEntriesToWire(text: string, entries: MentionEntry[]): string {
  if (entries.length === 0) return text;

  const codeRegions = findCodeRegions(text);
  const sorted = [...entries].sort((a, b) => b.start - a.start);
  let result = text;

  for (const entry of sorted) {
    if (entry.start < 0 || entry.end > result.length) continue;
    if (codeRegions.some((region) => entry.start >= region.start && entry.start < region.end)) continue;
    if (result.slice(entry.start, entry.end) !== `@${entry.username}`) continue;
    result = `${result.slice(0, entry.start)}@[uid:${entry.uid}]${result.slice(entry.end)}`;
  }
  return result;
}

export function useMentionAutocomplete(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  text: string,
  chatId: string | number | undefined,
): UseMentionAutocompleteResult {
  const [mentionState, setMentionState] = useState<MentionState>({
    isOpen: false,
    results: [],
    selectedIndex: 0,
    loading: false,
    query: '',
  });
  const [mentionEntries, setMentionEntries] = useState<MentionEntry[]>([]);
  const triggerStartRef = useRef<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const latestQueryRef = useRef('');

  const closeMention = useCallback(() => {
    setMentionState((prev) => (prev.isOpen ? { ...prev, isOpen: false, results: [], selectedIndex: 0 } : prev));
    triggerStartRef.current = null;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
  }, []);

  const fetchMembers = useCallback(
    (query: string) => {
      if (!chatId) return;
      latestQueryRef.current = query;
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setMentionState((prev) => ({ ...prev, loading: true }));

      getMembers(chatId, { q: query || undefined, mode: 'autocomplete', limit: 8 })
        .then((res) => {
          if (controller.signal.aborted) return;
          setMentionState((prev) => ({
            ...prev,
            results: res.data.members,
            loading: false,
            selectedIndex: 0,
          }));
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setMentionState((prev) => ({ ...prev, loading: false }));
        });
    },
    [chatId],
  );

  const onTextChange = useCallback(
    (newText: string) => {
      setMentionEntries((prev) => (prev.length === 0 ? prev : relocateMentionEntries(text, prev, newText)));

      const ta = textareaRef.current;
      if (!ta) {
        closeMention();
        return;
      }

      // Microtask so the cursor is read after React flushed the value.
      queueMicrotask(() => {
        const cursorPos = ta.selectionStart;
        const trigger = detectMentionTrigger(newText, cursorPos);
        if (!trigger) {
          closeMention();
          return;
        }

        triggerStartRef.current = trigger.triggerStart;
        setMentionState((prev) => ({
          ...prev,
          isOpen: true,
          query: trigger.query,
        }));

        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => fetchMembers(trigger.query), 250);
      });
    },
    [closeMention, fetchMembers, text, textareaRef],
  );

  const selectMention = useCallback(
    (member: MemberResponse) => {
      const ta = textareaRef.current;
      if (!ta || triggerStartRef.current == null) return;

      const displayText = `@${member.username ?? `User ${member.uid}`}`;
      const triggerStart = triggerStartRef.current;
      const cursorPos = ta.selectionStart;

      // Replace @query with @username (+ trailing space)
      const before = text.slice(0, triggerStart);
      const after = text.slice(cursorPos);
      const inserted = displayText + ' ';
      const newText = before + inserted + after;

      // Synthetic input event to update React state
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(ta, newText);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }

      const newCursorPos = triggerStart + inserted.length;
      requestAnimationFrame(() => {
        ta.setSelectionRange(newCursorPos, newCursorPos);
        ta.focus();
      });

      if (member.username) {
        setMentionEntries((prev) => [
          ...prev,
          {
            uid: member.uid,
            username: member.username!,
            start: triggerStart,
            end: triggerStart + displayText.length,
          },
        ]);
      }

      closeMention();
    },
    [closeMention, text, textareaRef],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!mentionState.isOpen) return false;

      const totalItems = mentionState.results.length;
      if (totalItems === 0) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeMention();
          return true;
        }
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionState((prev) => ({
          ...prev,
          selectedIndex: Math.min(prev.selectedIndex + 1, totalItems - 1),
        }));
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionState((prev) => ({
          ...prev,
          selectedIndex: Math.max(prev.selectedIndex - 1, 0),
        }));
        return true;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const member = mentionState.results[mentionState.selectedIndex];
        if (member) selectMention(member);
        return true;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closeMention();
        return true;
      }

      return false;
    },
    [closeMention, mentionState.isOpen, mentionState.results, mentionState.selectedIndex, selectMention],
  );

  const toWireFormat = useCallback(
    (displayText: string): string => mentionEntriesToWire(displayText, mentionEntries),
    [mentionEntries],
  );

  const clearMentions = useCallback(() => {
    setMentionEntries([]);
    closeMention();
  }, [closeMention]);

  return {
    mentionState,
    mentionEntries,
    selectMention,
    handleKeyDown,
    toWireFormat,
    clearMentions,
    onTextChange,
  };
}
