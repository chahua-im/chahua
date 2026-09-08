import type { ReactNode } from 'react';
import type { Token } from 'markdown-it';
import type { MentionInfo } from '@/api/messages';
import { MENTION_REGEX, MENTION_TEST, TRAILING_PUNCT, URL_REGEX } from '@/utils/chatTextMeasure';
import { parseInviteCodeFromUrl } from '@/utils/inviteUrl';
import { findCodeRegions } from '@/utils/markdown/codeRegions';
import { hasEscapedPunctuation } from '@/utils/markdown/detect';
import { markdownEngine } from '@/utils/markdown/engine';
import { buildPlaceholder } from '@/utils/markdown/placeholder';
import {
  renderMarkdownTokens,
  type MarkdownRenderOptions,
} from '@/utils/markdown/react-renderer';
import { tokensContainBlocks, tokensContainMarkup } from '@/utils/markdown/tokens';
import { decodePermalink } from '@/utils/permalinkUrl';
import styles from './ChatBubble.module.scss';
import { InviteLinkInline } from './InviteLinkInline';
import { PermalinkInline } from './PermalinkInline';

const PERMALINK_PATH_RE = /^\/m\/([A-Za-z0-9_-]+)$/;

function parsePermalinkFromUrl(url: string): { chatId: string; messageId: string; encoded: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== document.location.origin) return null;
    const match = PERMALINK_PATH_RE.exec(parsed.pathname);
    if (!match) return null;
    const encoded = match[1];
    const { chatId, messageId } = decodePermalink(encoded);
    return { chatId, messageId, encoded };
  } catch {
    return null;
  }
}

function mentionClassName(
  uid: number,
  currentUserUid: number | null | undefined,
  onMentionClick: ((uid: number) => void) | undefined,
): string {
  const isSelf = currentUserUid != null && uid === currentUserUid;
  const clickable = onMentionClick != null;
  return `${styles.mention}${isSelf ? ` ${styles.mentionSelf}` : ''}${clickable ? ` ${styles.mentionClickable}` : ''}`;
}

function buildMentionMap(mentions: MentionInfo[] | undefined): Map<number, string> {
  const map = new Map<number, string>();
  if (mentions) {
    for (const mention of mentions) {
      if (mention.username) map.set(mention.uid, mention.username);
    }
  }
  return map;
}

function renderMentionNode(
  uid: number,
  username: string | undefined,
  currentUserUid: number | null | undefined,
  onMentionClick: ((uid: number) => void) | undefined,
): ReactNode {
  return (
    <span
      className={mentionClassName(uid, currentUserUid, onMentionClick)}
      onClick={
        onMentionClick
          ? (event) => {
              event.stopPropagation();
              onMentionClick(uid);
            }
          : undefined
      }
    >
      @{username ?? `User ${uid}`}
    </span>
  );
}

/**
 * Renders a message body without any Markdown interpretation: splits out
 * mentions (`@[uid:N]`) and bare URLs (external / invite / `/m/…` permalink)
 * into their interactive widgets. This is the fallback used when the message
 * carries no Markdown meaning at all.
 */
export function renderMessageContentLegacy(
  message: string,
  mentions: MentionInfo[] | undefined,
  currentUserUid: number | null | undefined,
  onMentionClick: ((uid: number) => void) | undefined,
): ReactNode[] {
  const renderWithLinks = (text: string): ReactNode[] => {
    const parts = text.split(URL_REGEX);
    if (parts.length === 1) return [text];

    return parts.map((part, index) => {
      if (index % 2 === 1) {
        const trimmed = part.replace(TRAILING_PUNCT, '');
        const suffix = part.slice(trimmed.length);
        const inviteCode = parseInviteCodeFromUrl(trimmed);
        const permalink = !inviteCode ? parsePermalinkFromUrl(trimmed) : null;
        return (
          <span key={index}>
            {inviteCode ? (
              <InviteLinkInline code={inviteCode} url={trimmed} />
            ) : permalink ? (
              <PermalinkInline
                targetChatId={permalink.chatId}
                targetMessageId={permalink.messageId}
                encoded={permalink.encoded}
                url={trimmed}
              />
            ) : (
              <a
                href={trimmed}
                className={styles.messageLink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                {trimmed}
              </a>
            )}
            {suffix}
          </span>
        );
      }

      return part;
    });
  };

  if (!MENTION_TEST.test(message)) {
    return renderWithLinks(message);
  }

  const mentionMap = buildMentionMap(mentions);
  const regex = new RegExp(MENTION_REGEX);
  const result: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(message)) !== null) {
    if (match.index > lastIndex) {
      result.push(...renderWithLinks(message.slice(lastIndex, match.index)));
    }

    const uid = parseInt(match[1], 10);
    const username = mentionMap.get(uid);
    result.push(
      <span
        key={`mention-${uid}-${match.index}`}
        className={mentionClassName(uid, currentUserUid, onMentionClick)}
        onClick={
          onMentionClick
            ? (event) => {
                event.stopPropagation();
                onMentionClick(uid);
              }
            : undefined
        }
      >
        @{username ?? `User ${uid}`}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < message.length) {
    result.push(...renderWithLinks(message.slice(lastIndex)));
  }

  return result;
}



interface MentionWidget {
  uid: number;
  raw: string;
}

/**
 * Swaps every mention outside code regions for a markdown-safe placeholder.
 * The returned `body` is what gets parsed; `widgets` map placeholder slots back
 * to the original mentions while rendering.
 */
function extractMentionWidgets(message: string): { body: string; widgets: MentionWidget[] } {
  const regions = findCodeRegions(message);
  const widgets: MentionWidget[] = [];
  const parts: string[] = [];
  const regex = new RegExp(MENTION_REGEX);
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(message)) !== null) {
    // Leave mentions inside code verbatim — carving them would lose the text.
    if (regions.some((region) => match!.index >= region.start && match!.index < region.end)) {
      continue;
    }
    parts.push(message.slice(cursor, match.index));
    widgets.push({ uid: parseInt(match[1], 10), raw: match[0] });
    parts.push(buildPlaceholder(widgets.length - 1));
    cursor = match.index + match[0].length;
  }
  if (cursor < message.length) parts.push(message.slice(cursor));
  return { body: parts.join(''), widgets };
}

/**
 * Routes auto-detected invite / permalink URLs to their interactive widgets.
 * Explicit `[label](url)` links keep their label as ordinary safe anchors.
 */
function renderAutolinkWidget(href: string, _label: ReactNode, token: Token): ReactNode | null | undefined {
  if (token.info !== 'auto') return undefined;
  const inviteCode = parseInviteCodeFromUrl(href);
  const permalink = inviteCode ? null : parsePermalinkFromUrl(href);
  if (inviteCode) return <InviteLinkInline code={inviteCode} url={href} />;
  if (permalink) {
    return (
      <PermalinkInline
        targetChatId={permalink.chatId}
        targetMessageId={permalink.messageId}
        encoded={permalink.encoded}
        url={href}
      />
    );
  }
  return undefined;
}

export interface PreparedMessageContent {
  /** True when the body was rendered with Markdown; `nodes` is then non-null. */
  isMarkdown: boolean;
  /** True when Markdown produced block structure (heading/list/quote/code/hr/multi-paragraph). */
  hasBlocks: boolean;
  /** The rendered body when Markdown, otherwise null (use the legacy renderer). */
  nodes: ReactNode[] | null;
}

/**
 * One-shot Markdown analysis and rendering for a text message — the token list
 * from a single parse is shared between the decision and the render.
 */
export function prepareMessageContent(
  message: string,
  mentions: MentionInfo[] | undefined,
  currentUserUid: number | null | undefined,
  onMentionClick: ((uid: number) => void) | undefined,
): PreparedMessageContent {
  const extraction = extractMentionWidgets(message);
  const tokens = markdownEngine.parse(extraction.body, {});
  const isMarkdown = hasEscapedPunctuation(message) || tokensContainMarkup(tokens);

  if (!isMarkdown) {
    return { isMarkdown: false, hasBlocks: false, nodes: null };
  }

  const mentionMap = buildMentionMap(mentions);
  const options: MarkdownRenderOptions = {
    onPlaceholder: (index) => {
      const widget = extraction.widgets[index];
      if (!widget) return undefined;
      return renderMentionNode(widget.uid, mentionMap.get(widget.uid), currentUserUid, onMentionClick);
    },
    renderLink: renderAutolinkWidget,
  };

  return {
    isMarkdown: true,
    hasBlocks: tokensContainBlocks(tokens),
    nodes: renderMarkdownTokens(tokens, options),
  };
}

/**
 * Unified message-body renderer: runs Markdown rendering whenever the message
 * carries Markdown meaning, otherwise keeps the legacy plain-text renderer.
 */
export function renderMessageContent(
  message: string,
  mentions: MentionInfo[] | undefined,
  currentUserUid: number | null | undefined,
  onMentionClick: ((uid: number) => void) | undefined,
): ReactNode[] {
  const prepared = prepareMessageContent(message, mentions, currentUserUid, onMentionClick);
  if (prepared.isMarkdown && prepared.nodes) return prepared.nodes;
  return renderMessageContentLegacy(message, mentions, currentUserUid, onMentionClick);
}
