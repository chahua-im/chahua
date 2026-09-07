import { mockRealtime } from '../api/testing';
import { Connection } from '../api/connection';
import { encodeId } from '../api/snowflake-id';
import { jsonInterceptor } from '../api/json.interceptor';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { testChat, testMessage, wireChat, wireMessage } from '../api/testing';
import { ServerWsMessageType } from '../../generated/models';
import { ConversationStore, PageDirection, ConversationError } from './conversation-store';

const root = `/_api/chats/${wireChat.id}/messages`;
const message = (id: string) => ({ ...testMessage, id: encodeId(id) });
const wire = (id: string) => ({ ...wireMessage, id });

describe('ConversationStore', () => {
  let timeline: ConversationStore;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ConversationStore,
        { provide: Connection, useValue: mockRealtime() },
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
      ],
    });
    timeline = TestBed.inject(ConversationStore);
    http = TestBed.inject(HttpTestingController);
    timeline.reset(testChat.id);
  });
  afterEach(() => http.verify());

  it('stores only the message range and current paging edges from HTTP responses', async () => {
    const opening = timeline.open();
    http.expectOne(`${root}?max=50`).flush({
      messages: [wire('100')],
      olderCursor: '100',
      newerCursor: null,
      nextCursor: '80',
      prevCursor: '120',
    });
    await opening;
    expect(timeline.page()).toEqual({
      messages: [message('100')],
      olderCursor: encodeId('100'),
      newerCursor: undefined,
    });
    const older = timeline.load(PageDirection.Older);
    http.expectOne(`${root}?max=50&before=100`).flush({
      messages: [wire('99')],
      olderCursor: null,
      nextCursor: '1',
      prevCursor: '200',
    });
    await older;
    expect(timeline.page()).toEqual({
      messages: [message('99'), message('100')],
      olderCursor: undefined,
      newerCursor: undefined,
    });
  });

  it('buffers one fetched page until insertion is safe and preserves live arrivals', async () => {
    const opening = timeline.open();
    http.expectOne(`${root}?max=50`).flush({ messages: [wire('100')], olderCursor: '100' });
    await opening;
    let release!: () => void;
    const idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    const older = timeline.load(PageDirection.Older, () => idle);
    http.expectOne(`${root}?max=50&before=100`).flush({ messages: [wire('99')] });
    await Promise.resolve();
    expect(timeline.items()).toEqual([message('100')]);
    expect(timeline.canLoad(PageDirection.Older)).toBe(false);
    timeline.receive(message('101'));
    release();
    await older;
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('99'), encodeId('100'), encodeId('101')]);
  });

  it('discards a buffered page after navigation', async () => {
    const opening = timeline.open();
    http.expectOne(`${root}?max=50`).flush({ messages: [wire('100')], olderCursor: '100' });
    await opening;
    let release!: () => void;
    const idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    const older = timeline.load(PageDirection.Older, () => idle);
    http.expectOne(`${root}?max=50&before=100`).flush({ messages: [wire('99')] });
    await Promise.resolve();
    timeline.reset();
    release();
    await older;
    expect(timeline.items()).toEqual([]);
  });

  it('cancels an in-flight HTTP request and releases the range when its owner is destroyed', async () => {
    const opening = timeline.open();
    const request = http.expectOne(`${root}?max=50`);
    TestBed.resetTestingModule();
    expect(request.cancelled).toBe(true);
    expect(await opening).toBe(false);
    expect(timeline.items()).toEqual([]);
    expect(timeline.error()).toBeUndefined();
  });

  it('jumps directly to a distant message and keeps both paging edges independent', async () => {
    expect(timeline.atLatest()).toBe(false);
    expect(timeline.canLoad(PageDirection.Older)).toBe(false);
    const opening = timeline.open(encodeId('100'), true);
    http
      .expectOne(`${root}?max=50&around=100`)
      .flush({ messages: [wire('100'), wire('101')], olderCursor: '100', newerCursor: '101' });
    await opening;
    expect(timeline.atLatest()).toBe(false);
    expect(timeline.canLoad(PageDirection.Older)).toBe(true);
    expect(timeline.canLoad(PageDirection.Newer)).toBe(true);
    const older = timeline.load(PageDirection.Older);
    expect(timeline.canLoad(PageDirection.Older)).toBe(false);
    expect(timeline.canLoad(PageDirection.Newer)).toBe(false);
    http.expectOne(`${root}?max=50&before=100`).flush({ messages: [wire('99')], olderCursor: null, newerCursor: null });
    await older;
    expect(timeline.page()?.newerCursor).toBe(encodeId('101'));
    const newer = timeline.load(PageDirection.Newer);
    http.expectOne(`${root}?max=50&after=101`).flush({ messages: [wire('102')], newerCursor: null, olderCursor: '1' });
    await newer;
    expect(timeline.items().map((item) => item.id)).toEqual([
      encodeId('99'),
      encodeId('100'),
      encodeId('101'),
      encodeId('102'),
    ]);
    expect(timeline.page()?.olderCursor).toBeUndefined();
    expect(timeline.page()?.newerCursor).toBeUndefined();
    expect(timeline.atLatest()).toBe(true);
    expect(timeline.canLoad(PageDirection.Older)).toBe(false);
    expect(timeline.canLoad(PageDirection.Newer)).toBe(false);
  });

  it('preserves the current range if around only returns a deleted target’s neighbours', async () => {
    const initial = timeline.open();
    http.expectOne(`${root}?max=50`).flush({ messages: [{ ...wireMessage }], olderCursor: wireMessage.id });
    await initial;
    const jump = timeline.open(encodeId('100'), true);
    http.expectOne(`${root}?max=50&around=100`).flush({ messages: [wire('99'), wire('101')] });
    expect(await jump).toBe(false);
    expect(timeline.items()).toEqual([testMessage]);
    expect(timeline.error()).toBe(ConversationError.Missing);
  });

  it('does not stitch live messages onto a historical range or fetch the entire gap on reconnect', async () => {
    const opening = timeline.open(encodeId('100'));
    http
      .expectOne(`${root}?max=50&around=100`)
      .flush({ messages: [wire('100')], newerCursor: '100', olderCursor: '100' });
    await opening;
    timeline.receive(testMessage);
    await timeline.reconnect();
    expect(timeline.items()).toEqual([message('100')]);
    const latest = timeline.open();
    http.expectOne(`${root}?max=50`).flush({ messages: [{ ...wireMessage }], olderCursor: wireMessage.id });
    await latest;
    expect(timeline.items()).toEqual([testMessage]);
  });

  it('fetches only one reconnect batch and retains previously loaded history', async () => {
    const opening = timeline.open();
    http.expectOne(`${root}?max=50`).flush({ messages: [wire('100')], olderCursor: '100' });
    await opening;
    const reconnect = timeline.reconnect();
    http.expectOne(`${root}?max=50&after=100`).flush({ messages: [wire('101')], newerCursor: '101' });
    await reconnect;
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('100'), encodeId('101')]);
    expect(timeline.page()?.newerCursor).toBe(encodeId('101'));
  });

  it('cancels old navigation and pagination requests after a later jump', async () => {
    const opening = timeline.open(encodeId('100'));
    const staleOpen = http.expectOne(`${root}?max=50&around=100`);
    const latest = timeline.open();
    http.expectOne(`${root}?max=50`).flush({ messages: [{ ...wireMessage }], olderCursor: wireMessage.id });
    await latest;
    expect(staleOpen.cancelled).toBe(true);
    await opening;
    const paging = timeline.load(PageDirection.Older);
    const stalePage = http.expectOne(`${root}?max=50&before=${wireMessage.id}`);
    await timeline.open(testMessage.id, true);
    expect(stalePage.cancelled).toBe(true);
    await paging;
    expect(timeline.items()).toEqual([testMessage]);
    expect(timeline.loading()).toBe(false);
  });

  it('keeps a forward cursor for live messages arriving during an initial or reconnect request', async () => {
    const opening = timeline.open();
    timeline.receive(message('102'));
    http.expectOne(`${root}?max=50`).flush({ messages: [wire('100')], newerCursor: null });
    await opening;
    expect(timeline.page()?.newerCursor).toBe(encodeId('100'));
    const newer = timeline.load(PageDirection.Newer);
    timeline.receive(message('103'));
    http.expectOne(`${root}?max=50&after=100`).flush({ messages: [wire('101'), wire('102')], newerCursor: null });
    await newer;
    expect(timeline.page()?.newerCursor).toBe(encodeId('102'));
  });

  it('merges live messages arriving while older pages load without losing or duplicating them', async () => {
    const opening = timeline.open();
    http.expectOne(`${root}?max=50`).flush({ messages: [wire('100')], olderCursor: '100' });
    await opening;
    const older = timeline.load(PageDirection.Older);
    expect(timeline.atLatest()).toBe(true);
    timeline.receive(message('101'));
    timeline.receive(message('101'));
    http.expectOne(`${root}?max=50&before=100`).flush({ messages: [wire('99')], olderCursor: null });
    await older;
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('99'), encodeId('100'), encodeId('101')]);
    timeline.reset();
    expect(timeline.items()).toEqual([]);
  });
  it('reconciles a reconnect received while the initial request was in flight', async () => {
    const opening = timeline.open();
    await timeline.reconnect();
    http.expectOne(`${root}?max=50`).flush({ messages: [wire('100')], olderCursor: '100' });
    await Promise.resolve();
    http.expectOne(`${root}?max=50&after=100`).flush({ messages: [wire('101')], newerCursor: null });
    await opening;
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('100'), encodeId('101')]);
  });

  it('recovers the first live message when an empty initial snapshot arrives late', async () => {
    const opening = timeline.open();
    timeline.receive(message('100'));
    http.expectOne(`${root}?max=50`).flush({ messages: [] });
    await Promise.resolve();
    http.expectOne(`${root}?max=50`).flush({ messages: [wire('100')] });
    await opening;
    expect(timeline.items()).toEqual([message('100')]);
  });
  it('can reach the end after a historical range receives a reconnect event', async () => {
    const opening = timeline.open(encodeId('100'));
    http.expectOne(`${root}?max=50&around=100`).flush({ messages: [wire('100')], newerCursor: '100' });
    await opening;
    await timeline.reconnect();
    const newer = timeline.load(PageDirection.Newer);
    http.expectOne(`${root}?max=50&after=100`).flush({ messages: [wire('101')], newerCursor: null });
    await newer;
    expect(timeline.page()?.newerCursor).toBeUndefined();
  });

  it('scopes every topic page and reconnect request with the backend camelCase parameter', async () => {
    timeline.reset(testChat.id, encodeId('100'));
    const opening = timeline.open(encodeId('102'));
    http.expectOne(`${root}?max=50&around=102&threadId=100`).flush({
      messages: [{ ...wire('102'), replyRootId: '100' }],
      olderCursor: '102',
    });
    await opening;
    const older = timeline.load(PageDirection.Older);
    http.expectOne(`${root}?max=50&before=102&threadId=100`).flush({ messages: [wire('100')] });
    await older;
    timeline.receive(message('105'));
    timeline.receive({ ...message('104'), replyRootId: encodeId('99') });
    timeline.receive({ ...message('103'), replyRootId: encodeId('100') });
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('100'), encodeId('102'), encodeId('103')]);
    const reconnect = timeline.reconnect();
    http
      .expectOne(`${root}?max=50&after=103&threadId=100`)
      .flush({ messages: [{ ...wire('106'), replyRootId: '100' }] });
    await reconnect;
    expect(timeline.items().map((item) => item.id)).toEqual([
      encodeId('100'),
      encodeId('102'),
      encodeId('103'),
      encodeId('106'),
    ]);
  });

  it('rejects a previous topic response when changing topics inside the same chat', async () => {
    timeline.reset(testChat.id, encodeId('100'));
    const oldOpening = timeline.open(encodeId('100'));
    const oldRequest = http.expectOne(`${root}?max=50&around=100&threadId=100`);
    timeline.reset(testChat.id, encodeId('200'));
    const opening = timeline.open(encodeId('200'));
    http.expectOne(`${root}?max=50&around=200&threadId=200`).flush({ messages: [wire('200')] });
    await opening;
    expect(oldRequest.cancelled).toBe(true);
    await oldOpening;
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('200')]);
  });

  it('patches edits and single or bulk deletions in historical ranges without adding unrelated messages', async () => {
    const opening = timeline.open(encodeId('100'));
    http.expectOne(`${root}?max=50&around=100`).flush({
      messages: [wire('100'), wire('101'), wire('102')],
      olderCursor: '100',
      newerCursor: '102',
    });
    await opening;
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...message('100'), message: 'edited', isEdited: true },
    });
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...message('101'), isDeleted: true },
    });
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: {
        chatId: testChat.id,
        messageIds: [encodeId('102'), encodeId('99')],
      },
    });
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...message('99'), message: 'outside the loaded range' },
    });
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...message('100'), chatId: encodeId('999'), isDeleted: true },
    });
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: { chatId: encodeId('999'), messageIds: [encodeId('100')] },
    });
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('100'), encodeId('101'), encodeId('102')]);
    expect(timeline.items()[0]).toMatchObject({
      message: 'edited',
      isEdited: true,
      isDeleted: false,
    });
    expect(
      timeline
        .items()
        .slice(1)
        .every((item) => item.isDeleted),
    ).toBe(true);
    expect(timeline.page()).toMatchObject({
      olderCursor: encodeId('100'),
      newerCursor: encodeId('102'),
    });
  });

  it('preserves personal reaction state omitted from broadcasts and honors explicit changes and removals', async () => {
    const opening = timeline.open(encodeId('100'));
    http.expectOne(`${root}?max=50&around=100`).flush({
      messages: [
        {
          ...wire('100'),
          reactions: [{ emoji: '👍', count: 1, reactedByMe: true }],
        },
      ],
      newerCursor: '100',
    });
    await opening;
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.reactionUpdated,
      payload: {
        chatId: testChat.id,
        messageId: encodeId('100'),
        reactions: [{ emoji: '👍', count: 2 }],
      },
    });
    expect(timeline.items()[0].reactions).toEqual([{ emoji: '👍', count: 2, reactedByMe: true }]);
    timeline.update({
      ...message('100'),
      message: 'edited',
      reactions: [{ emoji: '👍', count: 3 }],
    });
    expect(timeline.items()[0].reactions).toEqual([{ emoji: '👍', count: 3, reactedByMe: true }]);
    timeline.updateReactions(encodeId('100'), [{ emoji: '👍', count: 2, reactedByMe: false }]);
    expect(timeline.items()[0].reactions).toEqual([{ emoji: '👍', count: 2, reactedByMe: false }]);
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.reactionUpdated,
      payload: {
        chatId: encodeId('999'),
        messageId: encodeId('100'),
        reactions: [],
      },
    });
    expect(timeline.items()[0].reactions).toHaveLength(1);
    timeline.updateReactions(encodeId('100'), []);
    expect(timeline.items()[0].reactions).toEqual([]);
  });

  it('replays edits and deletions received before the initial or older-page snapshot arrives', async () => {
    const opening = timeline.open(encodeId('100'));
    timeline.update({ ...message('100'), message: 'edited while loading' });
    timeline.updateReactions(encodeId('100'), [{ emoji: '👍', count: 1, reactedByMe: true }]);
    expect(timeline.items()).toEqual([]);
    http.expectOne(`${root}?max=50&around=100`).flush({
      messages: [wire('100')],
      olderCursor: '100',
      newerCursor: '100',
    });
    await opening;
    expect(timeline.items()[0]).toMatchObject({
      message: 'edited while loading',
      reactions: [{ emoji: '👍', count: 1, reactedByMe: true }],
    });
    const older = timeline.load(PageDirection.Older);
    timeline.update({
      ...message('99'),
      message: 'edited before paging completed',
    });
    timeline.delete(encodeId('98'));
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: { chatId: testChat.id, messageIds: [encodeId('97')] },
    });
    http.expectOne(`${root}?max=50&before=100`).flush({ messages: [wire('97'), wire('98'), wire('99'), wire('100')] });
    await older;
    expect(timeline.items().map((item) => item.id)).toEqual([
      encodeId('97'),
      encodeId('98'),
      encodeId('99'),
      encodeId('100'),
    ]);
    expect(
      timeline
        .items()
        .slice(0, 2)
        .every((item) => item.isDeleted),
    ).toBe(true);
    expect(timeline.items()[2].message).toBe('edited before paging completed');
    expect(timeline.items()[3].message).toBe('edited while loading');
  });

  it('keeps live edits and known reaction ownership during a jump but accepts a later fresh snapshot', async () => {
    const opening = timeline.open(encodeId('100'));
    http.expectOne(`${root}?max=50&around=100`).flush({
      messages: [
        {
          ...wire('100'),
          reactions: [{ emoji: '👍', count: 1, reactedByMe: true }],
        },
      ],
      newerCursor: '100',
    });
    await opening;
    const jump = timeline.open(encodeId('100'));
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageUpdated,
      payload: {
        ...message('100'),
        message: 'new edit',
        reactions: [{ emoji: '👍', count: 2 }],
      },
    });
    http.expectOne(`${root}?max=50&around=100`).flush({
      messages: [
        {
          ...wire('100'),
          reactions: [{ emoji: '👍', count: 1, reactedByMe: false }],
        },
      ],
      newerCursor: '100',
    });
    await jump;
    expect(timeline.items()[0]).toMatchObject({
      message: 'new edit',
      reactions: [{ emoji: '👍', count: 2, reactedByMe: true }],
    });
    const fresh = timeline.open(encodeId('100'));
    http.expectOne(`${root}?max=50&around=100`).flush({
      messages: [{ ...wire('100'), message: 'later server state', reactions: [] }],
    });
    await fresh;
    expect(timeline.items()[0]).toMatchObject({
      message: 'later server state',
      reactions: [],
    });
  });

  it('reports a deleted exact target when its deletion arrives during the request', async () => {
    const opening = timeline.open(encodeId('100'), true);
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...message('100'), isDeleted: true },
    });
    http.expectOne(`${root}?max=50&around=100`).flush({ messages: [wire('100')] });
    expect(await opening).toBe(false);
    expect(timeline.error()).toBe(ConversationError.Missing);
    expect(timeline.items()).toEqual([]);
  });

  it('keeps updates scoped to the active topic and clears pending updates after navigation', async () => {
    timeline.reset(testChat.id, encodeId('100'));
    const oldOpening = timeline.open(encodeId('100'));
    const oldRequest = http.expectOne(`${root}?max=50&around=100&threadId=100`);
    timeline.delete(encodeId('100'));
    timeline.reset(testChat.id, encodeId('200'));
    const opening = timeline.open(encodeId('200'));
    http.expectOne(`${root}?max=50&around=200&threadId=200`).flush({
      messages: [wire('200'), { ...wire('201'), replyRootId: '200' }],
      newerCursor: '201',
    });
    await opening;
    timeline.update({
      ...message('201'),
      replyRootId: encodeId('100'),
      message: 'another topic',
    });
    timeline.update({
      ...message('201'),
      replyRootId: encodeId('200'),
      message: 'this topic',
    });
    expect(oldRequest.cancelled).toBe(true);
    await oldOpening;
    expect(timeline.items()[0].isDeleted).toBe(false);
    expect(timeline.items()[1].message).toBe('this topic');
  });

  it('preserves reply counts received during loading and removes thread metadata after the last reply is deleted', async () => {
    const update = {
      chatId: testChat.id,
      threadRootId: encodeId('100'),
      replyCount: 3,
      lastReplyAt: testMessage.createdAt,
    };
    const opening = timeline.open(encodeId('100'));
    timeline.updateThread(update);
    http.expectOne(`${root}?max=50&around=100`).flush({
      messages: [{ ...wire('100'), threadInfo: { replyCount: 1 } }],
      newerCursor: '100',
    });
    await opening;
    expect(timeline.items()[0].threadInfo).toEqual({ replyCount: 3 });
    timeline.updateThread({ ...update, chatId: encodeId('999'), replyCount: 0 });
    expect(timeline.items()[0].threadInfo).toEqual({ replyCount: 3 });
    timeline.updateThread({ ...update, replyCount: 0 });
    expect(timeline.items()[0].threadInfo).toBeUndefined();
  });

  it('replays reply count changes for roots arriving in an older page without restoring cleared threads', async () => {
    const oldInfo = { replyCount: 1 };
    const opening = timeline.open(encodeId('101'));
    http.expectOne(`${root}?max=50&around=101`).flush({
      messages: [{ ...wire('101'), threadInfo: oldInfo }],
      olderCursor: '101',
      newerCursor: '101',
    });
    await opening;
    const older = timeline.load(PageDirection.Older);
    timeline.updateThread({
      chatId: testChat.id,
      threadRootId: encodeId('100'),
      replyCount: 2,
      lastReplyAt: testMessage.createdAt,
    });
    timeline.updateThread({
      chatId: testChat.id,
      threadRootId: encodeId('101'),
      replyCount: 0,
      lastReplyAt: testMessage.createdAt,
    });
    http.expectOne(`${root}?max=50&before=101`).flush({
      messages: [
        { ...wire('100'), threadInfo: oldInfo },
        { ...wire('101'), threadInfo: oldInfo },
      ],
    });
    await older;
    expect(timeline.items()[0].threadInfo).toEqual({ replyCount: 2 });
    expect(timeline.items()[1].threadInfo).toBeUndefined();
    expect(timeline.page()?.newerCursor).toBe(encodeId('101'));
  });
});
