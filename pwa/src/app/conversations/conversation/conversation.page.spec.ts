import { Location } from '@angular/common';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRouteSnapshot, NavigationEnd, provideRouter, Router, RouterLink } from '@angular/router';
import {
  IonActionSheet,
  IonContent,
  IonModal,
  IonPopover,
  IonRouterOutlet,
  IonTextarea,
  iosTransitionAnimation,
  NavController,
} from '@ionic/angular';
import { of, Subject } from 'rxjs';
import { vi } from 'vitest';
import WaveSurfer from 'wavesurfer.js';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import { PinsService } from '../../../generated/endpoints/pins/pins.service';
import {
  AttachmentUploadPurpose,
  GroupKind,
  GroupRole,
  MessageType,
  NotificationType,
  ServerWsMessageType,
  SpeakingMode,
  SystemMessageKind,
  type MessageResponse,
  type ServerWsMessage,
  type ThreadSubscriptionStatusResponse,
} from '../../../generated/models';
import { Connection, ResyncReason } from '../../api/connection';
import { jsonInterceptor } from '../../api/json.interceptor';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser, wireChat, wireMessage } from '../../api/testing';
import { ChatListStore } from '../../chats/chat-list-store';
import { ChatChangeKind, ChatStore } from '../../chats/chat-store';
import { ForwardPicker } from '../../messages/forward-picker/forward-picker';
import { ForwardSelectionError, forwardSourceMessage } from '../../messages/forwarding';
import { MessageDelivery } from '../../messages/message-delivery';
import { MessageAction } from '../../messages/message-menu/message-menu';
import { MessageNotice } from '../../messages/message-notice';
import { MessageOutbox, type OutgoingMessage } from '../../messages/message-outbox';
import { Message, type MessageContent } from '../../messages/message/message';
import { SavedMessageStore } from '../../messages/saved-message-store';
import { StickerFavorites } from '../../messages/sticker-favorites';
import { UploadStatus, type AttachmentUpload } from '../../messages/upload';
import { VoicePlayback, type VoiceDock } from '../../messages/voice-player/voice-playback';
import { VoicePlayer } from '../../messages/voice-player/voice-player';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { ConversationNavigation, ConversationTargetKind } from '../conversation-navigation';
import { ConversationError, PageDirection } from '../conversation-store';
import { DraftStore } from '../draft-store';
import { ConversationPage, ThreadError } from './conversation.page';

const otherSender = { uid: 2, name: '朋友', gender: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ConversationPage', () => {
  let component: ConversationPage;
  let fixture: ComponentFixture<ConversationPage>;
  let http: HttpTestingController;
  let incoming: Subject<MessageResponse>;
  let events: Subject<ServerWsMessage>;
  let resync: Subject<ResyncReason | void>;
  let subscriptions: WritableSignal<Map<SnowflakeID, ThreadSubscriptionStatusResponse>>;
  let scroll: HTMLElement;
  let resizes: Map<Element, () => void>;
  const avatars = signal(false);
  const dmDetails = signal(true);
  const membershipMessages = signal(true);
  beforeEach(async () => {
    vi.spyOn(IonActionSheet.prototype, 'present').mockResolvedValue();
    vi.spyOn(IonActionSheet.prototype, 'onDidDismiss').mockResolvedValue({
      role: 'selected',
      data: { mode: 'temporarilyMuted', durationSeconds: 3600 },
    });
    resizes = new Map();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly targets = new Set<Element>();
        constructor(private readonly callback: () => void) {}
        observe(target: Element) {
          this.targets.add(target);
          resizes.set(target, this.callback);
        }
        unobserve(target: Element) {
          this.targets.delete(target);
          resizes.delete(target);
        }
        disconnect() {
          for (const target of this.targets) resizes.delete(target);
        }
      },
    );
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.spyOn(IonModal.prototype, 'isOpen', 'set').mockImplementation(() => {});
    avatars.set(false);
    dmDetails.set(true);
    membershipMessages.set(true);
    incoming = new Subject<MessageResponse>();
    events = new Subject<ServerWsMessage>();
    resync = new Subject<ResyncReason | void>();
    subscriptions = signal(new Map());
    scroll = document.createElement('div');
    vi.spyOn(IonContent.prototype, 'getScrollElement').mockResolvedValue(scroll);
    await TestBed.configureTestingModule({
      imports: [ConversationPage, VoicePlayer],
      providers: [
        provideRouter([]),
        { provide: IonRouterOutlet, useValue: { canGoBack: vi.fn().mockReturnValue(true) } },
        { provide: Connection, useValue: mockRealtime({ messages$: incoming, events$: events, resync$: resync }) },
        {
          provide: SessionStore,
          useValue: {
            requireChatSettings: SessionStore.prototype.requireChatSettings,
            acceptChatSettings: SessionStore.prototype.acceptChatSettings,
            user: signal(testUser),
          },
        },
        {
          provide: Preferences,
          useValue: { showAllAvatars: avatars, showDmDetails: dmDetails, showMembershipMessages: membershipMessages },
        },
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        {
          provide: SavedMessageStore,
          useValue: {
            ensure: () => Promise.resolve(),
            isSaved: () => false,
            loading: () => false,
            save: vi.fn(),
            unsave: vi.fn(),
          },
        },
        {
          provide: StickerFavorites,
          useValue: {
            ensure: () => Promise.resolve(),
            isFavorite: () => false,
            loading: () => false,
            set: vi.fn(),
          },
        },
      ],
    }).compileComponents();
    vi.spyOn(TestBed.inject(PinsService), 'listPins').mockImplementation((() =>
      of({ pins: [] })) as unknown as PinsService['listPins']);
    vi.spyOn(TestBed.inject(PinsService), 'listThreadPins').mockImplementation((() =>
      of({ pins: [] })) as unknown as PinsService['listThreadPins']);
    vi.spyOn(TestBed.inject(ChatsService), 'getChatReactions').mockImplementation((() =>
      of({ messageIds: [], readThrough: '2026-10-20T00:00:00Z' })) as unknown as ChatsService['getChatReactions']);
    vi.spyOn(TestBed.inject(ChatsService), 'getChatMentions').mockImplementation((() =>
      of({ messageIds: [] })) as unknown as ChatsService['getChatMentions']);
    vi.spyOn(TestBed.inject(ChatsService), 'acknowledgeChatReactions').mockImplementation((() =>
      of({ unreadReactions: 0 })) as unknown as ChatsService['acknowledgeChatReactions']);
    vi.spyOn(TestBed.inject(Router), 'isActive').mockReturnValue(true);
    Object.assign(TestBed.inject(ChatStore), {
      threadReadState: vi.fn().mockReturnValue(undefined),
      subscription: (_chatId: SnowflakeID, rootId: SnowflakeID) => subscriptions().get(rootId),
      loadSubscription: vi.fn().mockResolvedValue(undefined),
      markThreadRead: vi.fn().mockResolvedValue(undefined),
      setThreadArchived: vi.fn().mockResolvedValue(undefined),
      subscribeThread: vi.fn().mockResolvedValue(undefined),
      cachedReadState: vi
        .fn()
        .mockReturnValue({ lastReadMessageId: testChat.lastReadMessageId, unreadCount: testChat.unreadCount }),
      refreshChats: vi.fn(),
      markRead: vi.fn().mockResolvedValue(undefined),
      getReadState: vi.fn().mockResolvedValue({ unreadCount: 0 }),
    });
    TestBed.inject(ChatStore).remember([testChat]);
    fixture = TestBed.createComponent(ConversationPage);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    fixture.componentRef.setInput('id', wireChat.id);
    fixture.detectChanges();
    http
      .expectOne(`/_api/group/${wireChat.id}`)
      .flush({ ...wireChat, myRole: GroupRole.member, speakingMode: 'unrestricted', mySpeakingMode: 'unrestricted' });
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage }],
      olderCursor: wireMessage.id,
    });
    await fixture.whenStable();
    fixture.detectChanges();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.inject(VoicePlayback).active.set(undefined);
    http.verify();
  });

  it('applies live restrictions without replacing the composer or draft, and resumes after restoration', async () => {
    component['updateDraft']('保留草稿');
    fixture.detectChanges();
    const composer = fixture.nativeElement.querySelector('app-message-composer');
    const row = fixture.nativeElement.querySelector('app-message');
    events.next({
      type: ServerWsMessageType.groupSpeakingModeChanged,
      payload: {
        chatId: testChat.id,
        speakingMode: SpeakingMode.readOnly,
      },
    });
    fixture.detectChanges();
    expect(component['composer']()!.restriction()).toBe(SpeakingMode.readOnly);
    expect(fixture.nativeElement.querySelector('app-message-composer')).toBe(composer);
    expect(fixture.nativeElement.querySelector('app-message')).toBe(row);
    expect(component['draft']()).toBe('保留草稿');
    await component['sendMessage']();
    http.expectNone((req) => req.method === 'POST');
    events.next({
      type: ServerWsMessageType.groupSpeakingModeChanged,
      payload: {
        chatId: testChat.id,
        speakingMode: SpeakingMode.unrestricted,
      },
    });
    expect(component['speakingRestriction']()).toBeUndefined();
    expect(component['draft']()).toBe('保留草稿');
  });

  it('distinguishes new threads, existing replies and editing the root under replies-only restrictions', () => {
    events.next({
      type: ServerWsMessageType.groupSpeakingModeChanged,
      payload: {
        chatId: testChat.id,
        speakingMode: SpeakingMode.repliesOnly,
      },
    });
    expect(component['canSendMessage']()).toBe(false);
    fixture.componentRef.setInput('threadId', wireMessage.id);
    expect(component['canSendMessage']()).toBe(false);
    events.next({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, threadInfo: { replyCount: 1 } },
    });
    expect(component['canSendMessage']()).toBe(true);
    component['editTarget'].set(testMessage);
    expect(component['speakingRestriction']()).toBe(SpeakingMode.repliesOnly);
    component['editTarget'].set({ ...testMessage, replyRootId: testMessage.id });
    expect(component['speakingRestriction']()).toBeUndefined();
    events.next({
      type: ServerWsMessageType.groupSpeakingModeChanged,
      payload: {
        chatId: testChat.id,
        speakingMode: SpeakingMode.readOnly,
      },
    });
    expect(component['speakingRestriction']()).toBe(SpeakingMode.readOnly);
  });

  it('keeps replies-only permission after unsubscribing, but revokes it when the thread loses its replies', async () => {
    const store = TestBed.inject(ChatStore);
    const rootId = encodeId('100');
    const thread = {
      chatId: testChat.id,
      chatKind: testChat.kind,
      chatName: '测试群',
      threadRootMessage: { ...testMessage, id: rootId, mentions: [] },
      participants: [],
      replyCount: 100,
      subscribedAt: testMessage.createdAt,
      lastReplyAt: testMessage.createdAt,
      archived: false,
      unreadCount: 0,
    };
    store.acceptThreads([thread], store.snapshot(), store.subscriptionSnapshot());
    fixture.componentRef.setInput('threadId', '100');
    // The root is outside the loaded message window; its preview comes from the thread list.
    component['conversation'].reset(testChat.id, rootId);
    events.next({
      type: ServerWsMessageType.groupSpeakingModeChanged,
      payload: { chatId: testChat.id, speakingMode: SpeakingMode.repliesOnly },
    });
    await component['loadThreadRoot']();
    expect(component['loadedThreadRoot']()).toBeUndefined();
    expect(component['canSendMessage']()).toBe(true);
    const root = component['threadRoot']();
    events.next({
      type: ServerWsMessageType.threadMembershipChanged,
      payload: { chatId: testChat.id, threadRootId: rootId, status: { subscribed: false, archived: false } },
    });
    expect(store.thread(rootId)).toBeUndefined();
    expect(component['threadRoot']()).toBe(root);
    expect(component['topicMessageCount']()).toBe(101);
    expect(component['canSendMessage']()).toBe(true);
    expect(component['speakingRestriction']()).toBeUndefined();

    const readVersion = store.snapshot();
    const subscriptionVersion = store.subscriptionSnapshot();
    events.next({
      type: ServerWsMessageType.threadUpdate,
      payload: { chatId: testChat.id, threadRootId: rootId, replyCount: 0, lastReplyAt: testMessage.createdAt },
    });
    expect(component['canSendMessage']()).toBe(false);
    expect(component['topicMessageCount']()).toBe(1);
    store.acceptThreads([thread], readVersion, subscriptionVersion);
    expect(component['canSendMessage']()).toBe(false);
    http.expectNone(() => true);
  });

  it.each([false, true])(
    'updates a separately fetched root when replies disappear (during read: %s)',
    async (duringRead) => {
      const rootId = encodeId('100');
      fixture.componentRef.setInput('threadId', '100');
      component['conversation'].reset(testChat.id, rootId);
      component['draft'].set('保留草稿');
      events.next({
        type: ServerWsMessageType.groupSpeakingModeChanged,
        payload: { chatId: testChat.id, speakingMode: SpeakingMode.repliesOnly },
      });
      const loading = component['loadThreadRoot']();
      const read = http.expectOne(`/_api/chats/${wireChat.id}/messages/100`);
      const update = (replyCount: number) =>
        events.next({
          type: ServerWsMessageType.threadUpdate,
          payload: { chatId: testChat.id, threadRootId: rootId, replyCount, lastReplyAt: testMessage.createdAt },
        });
      if (duringRead) update(0);
      read.flush({ ...wireMessage, id: '100', threadInfo: { replyCount: 1 } });
      await loading;
      if (!duringRead) {
        expect(component['canSendMessage']()).toBe(true);
        update(0);
      }
      expect(component['canSendMessage']()).toBe(false);
      expect(component['topicMessageCount']()).toBe(1);
      expect(component['threadRoot']()?.message).toBe(testMessage.message);
      expect(component['draft']()).toBe('保留草稿');
      update(1);
      expect(component['canSendMessage']()).toBe(true);
      http.expectNone(() => true);
    },
  );

  it('keeps a live root edit when its earlier detail response arrives late', async () => {
    const rootId = encodeId('100');
    fixture.componentRef.setInput('threadId', '100');
    component['conversation'].reset(testChat.id, rootId);
    const loading = component['loadThreadRoot']();
    events.next({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, id: rootId, message: '新内容', threadInfo: { replyCount: 2 } },
    });
    http.expectOne(`/_api/chats/${wireChat.id}/messages/100`).flush({
      ...wireMessage,
      id: '100',
      threadInfo: { replyCount: 1 },
    });
    await loading;
    expect(component['threadRoot']()?.message).toBe('新内容');
    expect(component['topicMessageCount']()).toBe(3);
  });

  it('uses list-cached DM information without fetching group permissions, but still loads group details', async () => {
    const store = TestBed.inject(ChatStore);
    store.invalidate();
    store.remember([{ ...testChat, kind: GroupKind.dm }]);
    await component['loadChatInfo']();
    http.expectNone(`/_api/group/${wireChat.id}`);
    store.remember([testChat]);
    const loading = component['loadChatInfo']();
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat, speakingMode: SpeakingMode.readOnly });
    await loading;
    expect(component['canSendMessage']()).toBe(false);
  });

  it('retains draft and message nodes while selecting, enforces 100 items, and freezes the submitted selection', () => {
    component['draft'].set('unfinished draft');
    const node = fixture.nativeElement.querySelector('app-message');
    component['beginSelection'](testMessage);
    for (let index = 0; index < 105; index++)
      component['toggleSelection']({ ...testMessage, id: encodeId(String(100 + index)) });
    expect(component['selectedMessages']().size).toBe(100);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-message')).toBe(node);
    expect(fixture.nativeElement.querySelector('app-message-composer').hidden).toBe(true);
    component['forwardSelection']();
    expect(component['forwardSources']()).toHaveLength(100);
    component['toggleSelection'](testMessage);
    expect(component['forwardSources']()).toHaveLength(100);
    component['forwardSources'].set([]);
    component['cancelSelection']();
    fixture.detectChanges();
    expect(component['draft']()).toBe('unfinished draft');
    expect(fixture.nativeElement.querySelector('app-message')).toBe(node);
  });

  it('shows a removable forward preview in the destination without sending or replacing its text', () => {
    const send = vi.spyOn(component['outbox'], 'enqueueForward');
    component['draft'].set('existing draft');
    component['startReply'](testMessage);
    TestBed.inject(DraftStore).setForward(testChat.id, undefined, [testMessage]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.forward-context strong').textContent.trim()).toBe(
      testMessage.sender.name,
    );
    expect(fixture.nativeElement.querySelector('.forward-context app-message-preview')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.forward-context').textContent).not.toContain('转发 1 条消息');
    expect(component['draft']()).toBe('existing draft');
    expect(send).not.toHaveBeenCalled();
    (fixture.nativeElement.querySelector('.forward-context .reply-close') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.forward-context')).toBeNull();
    expect(component['draft']()).toBe('existing draft');
    expect(component['replyTo']()).toBe(testMessage);
  });

  it('uses the original sender for a single forwarded message preview', () => {
    const source = {
      ...testMessage,
      forwardedFrom: {
        sender: { uid: 99, name: '源头作者', gender: 0 },
        originalChatId: testChat.id,
        originalMessageId: encodeId('99'),
      },
    };
    TestBed.inject(DraftStore).setForward(testChat.id, undefined, [source]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.forward-context strong').textContent.trim()).toBe('源头作者');
  });

  it('opens the destination picker from the forward icon and keeps the draft when cancelled', () => {
    const lists = TestBed.inject(ChatListStore);
    vi.spyOn(lists.chats(false), 'activate').mockReturnValue(() => {});
    vi.spyOn(lists.threads(false), 'activate').mockReturnValue(() => {});
    const sources = [testMessage, { ...testMessage, id: encodeId('100') }];
    const drafts = TestBed.inject(DraftStore);
    drafts.setForward(testChat.id, undefined, sources);
    component['draft'].set('existing text');
    const send = vi.spyOn(component['outbox'], 'enqueueForward');
    fixture.detectChanges();

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.forward-target-button');
    expect(button.title).toBe('更换转发目标');
    expect(button.querySelectorAll('.forward-target-icon ion-icon')).toHaveLength(2);
    button.click();
    fixture.detectChanges();
    const picker = fixture.debugElement.query(By.directive(ForwardPicker)).componentInstance as ForwardPicker;
    expect(picker.messages()).toBe(sources);
    expect(picker.moveFrom()).toMatchObject({ chatId: testChat.id, threadId: undefined });
    picker.closed.emit();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.directive(ForwardPicker))).toBeNull();
    expect(drafts.forward(testChat.id)).toBe(sources);
    expect(component['draft']()).toBe('existing text');
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the comment in the original input and saves it there after moving a forward', async () => {
    const drafts = TestBed.inject(DraftStore);
    const sources = [testMessage];
    const target = encodeId('222');
    drafts.setForward(testChat.id, undefined, sources);
    component['draft'].set('comment to move');
    component['changeForwardTarget']();
    const origin = component['forwardMove']()!;
    component['forwardMove'].set(undefined);
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await TestBed.inject(ConversationNavigation).prepareForward(target, undefined, sources, origin);
    expect(component['draft']()).toBe('comment to move');
    component['saveDraft']();
    expect(drafts.get(testChat.id)?.text).toBe('comment to move');
    expect(drafts.get(target)).toBeUndefined();
  });

  it('preserves the retained destination input when moving a forward from another chat', async () => {
    const drafts = TestBed.inject(DraftStore);
    component['draft'].set('unsaved destination text');
    const origin = encodeId('222');
    drafts.save(origin, undefined, 'comment');
    expect(component['draft']()).toBe('unsaved destination text');
    component['saveDraft']();
    const sources = [testMessage];
    drafts.setForward(origin, undefined, sources);
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await TestBed.inject(ConversationNavigation).prepareForward(testChat.id, undefined, sources, { chatId: origin });
    fixture.detectChanges();
    expect(component['draft']()).toBe('unsaved destination text');
    expect(fixture.debugElement.query(By.directive(IonTextarea)).componentInstance.value).toBe(
      'unsaved destination text',
    );
    component['saveDraft']();
    expect(drafts.get(testChat.id)?.text).toBe('unsaved destination text');
  });

  it.each([
    { uids: [1, 1], title: 'user1' },
    { uids: [1, 2, 1], title: 'user1和user2' },
    { uids: [1, 2, 3, 1], title: 'user1和其他2人' },
    { uids: [1, 2, 3, 4], title: 'user1和其他3人' },
  ])('summarizes merged participants in message order: $title', ({ uids, title }) => {
    const sources = uids
      .map((uid, index) => ({
        ...testMessage,
        id: encodeId(String(100 + index)),
        sender: { uid, name: `user${uid}`, gender: 0 },
      }))
      .reverse();
    TestBed.inject(DraftStore).setForward(testChat.id, undefined, sources);
    fixture.detectChanges();
    const preview = fixture.nativeElement.querySelector('.forward-context');
    expect(preview.querySelector('strong').textContent.trim()).toBe(title);
    expect(preview.querySelector('.reply-description > span').textContent.trim()).toBe(`转发 ${uids.length} 条消息`);
    expect(preview.querySelector('app-message-preview')).toBeNull();
  });

  it('sends a forward and then the composer text only when Send is clicked', async () => {
    component['draft'].set('附言');
    TestBed.inject(DraftStore).setForward(testChat.id, undefined, [testMessage]);
    fixture.detectChanges();
    http.expectNone((request) => request.method === 'POST');
    (fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement).click();
    const forward = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}/forward`);
    http.expectNone(`/_api/chats/${wireChat.id}/messages`);
    expect(component['pendingForward']()).toBeUndefined();
    expect(component['draft']()).toBe('');
    component['draft'].set('next input');
    forward.flush({
      ...wireMessage,
      id: '9007199254741800',
      clientGeneratedId: forward.request.body.clientGeneratedId,
    });
    await Promise.resolve();
    await Promise.resolve();
    const comment = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    expect(comment.request.body.message).toBe('附言');
    comment.flush({
      ...wireMessage,
      id: '9007199254741801',
      message: '附言',
      clientGeneratedId: comment.request.body.clientGeneratedId,
    });
    await fixture.whenStable();
    expect(component['draft']()).toBe('next input');
  });

  it('allows sending a merged forward without text', () => {
    const send = vi.spyOn(component['outbox'], 'enqueueForward').mockReturnValue({} as OutgoingMessage);
    const sources = [testMessage, { ...testMessage, id: encodeId('100') }];
    TestBed.inject(DraftStore).setForward(testChat.id, undefined, sources);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();
    expect(send).toHaveBeenCalledWith(testChat.id, undefined, sources, expect.objectContaining({ comment: '' }));
    expect(component['pendingForward']()).toBeUndefined();
  });

  it('temporarily shows the forward composer without overwriting an unfinished edit', () => {
    component['draft'].set('normal draft');
    component['startEdit'](testMessage);
    component['updateDraft']('unfinished edit');
    fixture.detectChanges();
    TestBed.inject(DraftStore).setForward(testChat.id, undefined, [testMessage]);
    fixture.detectChanges();
    expect(component['composer']()?.text()).toBe('normal draft');
    component['updateDraft']('forward comment');
    component['escapeComposer']();
    fixture.detectChanges();
    expect(component['composer']()?.text()).toBe('unfinished edit');
    expect(component['draft']()).toBe('forward comment');
  });

  it('submits nested sources without deciding placeholder replacement from the draft', () => {
    const send = vi.spyOn(component['outbox'], 'enqueueForward').mockReturnValue({} as OutgoingMessage);
    const sources = [
      {
        ...testMessage,
        messageType: MessageType.forwarded,
        forwardedPreview: { total: 2, containsForwardedMessages: true, messages: [] },
      },
      { ...testMessage, id: encodeId('100') },
    ];
    TestBed.inject(DraftStore).setForward(testChat.id, undefined, sources);
    component['draft'].set('附言');
    fixture.detectChanges();
    component['sendForward']();
    expect(send).toHaveBeenCalledExactlyOnceWith(testChat.id, undefined, sources, {
      comment: '附言',
      commentMentions: [],
    });
    expect(component['pendingForward']()).toBeUndefined();
  });

  it('keeps the selected preview through source changes and withholds the comment on server rejection', async () => {
    const sources = [testMessage];
    TestBed.inject(DraftStore).setForward(testChat.id, undefined, sources);
    component['draft'].set('附言');
    events.next({ type: ServerWsMessageType.messageUpdated, payload: { ...testMessage, message: 'edited' } });
    events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } });
    fixture.detectChanges();
    expect(component['forwardPreview']()).toBe(testMessage);
    const button = fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();
    const item = TestBed.inject(MessageOutbox).items()[0];
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}/forward`);
    expect(request.request.method).toBe('POST');
    http.expectNone(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`);
    request.flush('Source unavailable', { status: 404, statusText: 'Not Found' });
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    http.expectNone(`/_api/chats/${wireChat.id}/messages`);
  });

  it('Escape leaves multi-selection without reaching the page-level navigation shortcut', () => {
    component['beginSelection'](testMessage);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    fixture.nativeElement.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(component['selecting']()).toBe(false);
    expect(component['selectedMessages']().size).toBe(0);
  });

  it('clears mention and reaction targets as scrolling advances the read cursor', () => {
    component['mentionJumpIds'].set([encodeId('201'), encodeId('202')]);
    component['reactionJumpIds'].set([encodeId('302'), encodeId('301')]);
    const changes = TestBed.inject(ChatStore) as unknown as {
      changes: { next: (change: object) => void };
    };
    changes.changes.next({
      kind: ChatChangeKind.Read,
      chatId: testChat.id,
      readThrough: encodeId('201'),
    });
    expect(component['mentionJumpIds']()).toEqual([encodeId('202')]);
    expect(component['reactionJumpIds']()).toEqual([encodeId('302'), encodeId('301')]);
    changes.changes.next({
      kind: ChatChangeKind.Read,
      chatId: testChat.id,
      readThrough: encodeId('301'),
    });
    expect(component['reactionJumpIds']()).toEqual([encodeId('302')]);
  });

  it('keeps a one-item multi-selection eligible for forwarding and removes recalled selections', () => {
    component['beginSelection'](testMessage);
    component['forwardSelection']();
    expect(component['forwardSources']()).toEqual([testMessage]);
    events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } });
    expect(component['selectedMessages']().size).toBe(0);
    expect(component['forwardSources']()).toEqual([testMessage]);
    component['forwardSources'].set([]);
    component['cancelSelection']();
  });

  it('recalls multiple selected messages in one request and applies the response without a WebSocket echo', async () => {
    const second = { ...testMessage, id: encodeId('902'), clientGeneratedId: 'second' };
    component['beginSelection'](testMessage);
    component['toggleSelection'](second);
    component['recallSelection']();
    const recall = component['confirmRecallSelection'](new CustomEvent('dismiss', { detail: { role: 'confirm' } }));
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages/bulk-delete`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ messageIds: [wireMessage.id, '902'] });
    http.expectNone((request) => request.method === 'DELETE');
    request.flush({ chatId: wireChat.id, messageIds: [wireMessage.id, '902'], complete: true, threadRootIds: [] });
    await recall;
    expect(component['recallResult']()).toEqual({ succeeded: 2, failed: 0 });
    expect(component['selecting']()).toBe(false);
    expect(component['rows']().some((row) => row.message.id === testMessage.id)).toBe(false);
  });

  it('preserves the entire selection when a batch is rejected', async () => {
    component['beginSelection'](testMessage);
    component['toggleSelection']({ ...testMessage, id: encodeId('902'), clientGeneratedId: 'second' });
    component['recallSelection']();
    const recall = component['confirmRecallSelection'](new CustomEvent('dismiss', { detail: { role: 'confirm' } }));
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages/bulk-delete`)
      .flush('Forbidden', { status: 403, statusText: 'Forbidden' });
    await recall;
    expect(component['recallResult']()).toEqual({ succeeded: 0, failed: 2 });
    expect(component['selectedMessages']().size).toBe(2);
  });

  it('does not let a late batch response change a new selection', async () => {
    component['beginSelection'](testMessage);
    component['recallSelection']();
    const recall = component['confirmRecallSelection'](new CustomEvent('dismiss', { detail: { role: 'confirm' } }));
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages/bulk-delete`);
    component['cancelSelection']();
    const second = { ...testMessage, id: encodeId('902'), clientGeneratedId: 'second' };
    component['beginSelection'](second);
    request.flush({ chatId: wireChat.id, messageIds: [wireMessage.id], complete: true, threadRootIds: [] });
    await recall;
    expect([...component['selectedMessages']().values()]).toEqual([second]);
    expect(component['recallResult']()).toBeUndefined();
    expect(component['recalling']()).toBe(false);
  });

  async function acknowledgedSelection(messageType = MessageType.text) {
    const item = TestBed.inject(MessageOutbox).enqueue(testChat.id, undefined, 'queued', {
      messageType,
      attachmentIds: [],
    });
    const response = { ...wireMessage, id: '901', messageType, clientGeneratedId: item.clientGeneratedId };
    http.expectOne(`/_api/chats/${wireChat.id}/messages`).flush(response);
    await item.operation;
    component['beginSelection'](item);
    return { item, response };
  }

  it('keeps a rejected queued recall selected and reports success only after a successful retry', async () => {
    const { item } = await acknowledgedSelection();
    component['recallSelection']();
    const recall = component['confirmRecallSelection'](new CustomEvent('dismiss', { detail: { role: 'confirm' } }));
    await Promise.resolve();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages/bulk-delete`)
      .flush('Forbidden', { status: 403, statusText: 'Forbidden' });
    await recall;
    expect(component['recallResult']()).toEqual({ succeeded: 0, failed: 1 });
    expect(component['selectedMessages']().size).toBe(1);
    expect(component['canRecallSelection']()).toBe(true);
    expect(item.cancelled()).toBe(false);
    component['recallSelection']();
    const retry = component['confirmRecallSelection'](new CustomEvent('dismiss', { detail: { role: 'confirm' } }));
    await Promise.resolve();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages/bulk-delete`)
      .flush({ chatId: wireChat.id, messageIds: ['901'], complete: true, threadRootIds: [] });
    await retry;
    expect(component['recallResult']()).toEqual({ succeeded: 1, failed: 0 });
    expect(component['selecting']()).toBe(false);
  });

  it('waits for selected audio publication and then confirms its server deletion', async () => {
    const { item } = await acknowledgedSelection(MessageType.audio);
    component['recallSelection']();
    const recall = component['confirmRecallSelection'](new CustomEvent('dismiss', { detail: { role: 'confirm' } }));
    await Promise.resolve();
    expect(component['recalling']()).toBe(true);
    expect(component['recallResult']()).toBeUndefined();
    expect(item.cancelled()).toBe(false);
    http.expectNone((request) => request.url.endsWith('/bulk-delete') || request.method === 'DELETE');
    incoming.next(item.confirmed()!);
    await Promise.resolve();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages/bulk-delete`)
      .flush({ chatId: wireChat.id, messageIds: ['901'], complete: true, threadRootIds: [] });
    await recall;
    expect(component['recallResult']()).toEqual({ succeeded: 1, failed: 0 });
  });

  it('does not issue a late bulk recall after leaving a selection that waits for audio publication', async () => {
    const { item } = await acknowledgedSelection(MessageType.audio);
    component['recallSelection']();
    const recall = component['confirmRecallSelection'](new CustomEvent('dismiss', { detail: { role: 'confirm' } }));
    component['cancelSelection']();
    incoming.next(item.confirmed()!);
    await recall;
    http.expectNone((request) => request.url.endsWith('/bulk-delete') || request.method === 'DELETE');
    expect(component['recallResult']()).toBeUndefined();
    expect(item.cancelled()).toBe(false);
  });

  it('batches published audio with other selected messages and skips remote recalls during the wait', async () => {
    const { item } = await acknowledgedSelection(MessageType.audio);
    component['toggleSelection'](testMessage);
    const other = { ...testMessage, id: encodeId('903'), clientGeneratedId: 'other-selected' };
    component['toggleSelection'](other);
    component['recallSelection']();
    const recall = component['confirmRecallSelection'](new CustomEvent('dismiss', { detail: { role: 'confirm' } }));
    http.expectNone((request) => request.url.endsWith('/bulk-delete'));
    events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...other, isDeleted: true } });
    incoming.next(item.confirmed()!);
    await Promise.resolve();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages/bulk-delete`);
    expect(request.request.body).toEqual({ messageIds: ['901', wireMessage.id] });
    request.flush({ chatId: wireChat.id, messageIds: ['901', wireMessage.id], complete: true, threadRootIds: [] });
    await recall;
    expect(component['recallResult']()).toEqual({ succeeded: 2, failed: 0 });
    expect(component['selecting']()).toBe(false);
  });

  it('keeps an audio publication failure selected while recalling the ready messages in one batch', async () => {
    const { item } = await acknowledgedSelection(MessageType.audio);
    vi.spyOn(TestBed.inject(MessageOutbox), 'waitForPublication').mockRejectedValue(new Error('publication timeout'));
    component['toggleSelection'](testMessage);
    component['recallSelection']();
    const recall = component['confirmRecallSelection'](new CustomEvent('dismiss', { detail: { role: 'confirm' } }));
    await Promise.resolve();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages/bulk-delete`);
    expect(request.request.body).toEqual({ messageIds: [wireMessage.id] });
    request.flush({ chatId: wireChat.id, messageIds: [wireMessage.id], complete: true, threadRootIds: [] });
    await recall;
    expect(component['recallResult']()).toEqual({ succeeded: 1, failed: 1 });
    expect([...component['selectedMessages']().values()]).toEqual([item]);
    expect(item.cancelled()).toBe(false);
  });

  it.each([undefined, wireMessage.id])('ignores DM mention/reply navigation for thread %s', async (threadId) => {
    TestBed.inject(ChatStore).remember([{ ...testChat, kind: GroupKind.dm }]);
    fixture.componentRef.setInput('threadId', threadId);
    const query = vi.mocked(TestBed.inject(ChatsService).getChatMentions);
    query.mockClear();
    component['mentionJumpIds'].set([testMessage.id]);
    expect(component['canJumpMention']()).toBe(false);
    await component['enterMentionSession']();
    expect(query).not.toHaveBeenCalled();
    expect(component['mentionJumpIds']()).toEqual([]);
  });

  it('hides skeleton avatars and collapses message details for dm chats when the preference is off', async () => {
    TestBed.inject(ChatStore).remember([{ ...testChat, kind: GroupKind.dm }]);
    dmDetails.set(false);
    fixture.destroy();
    fixture = TestBed.createComponent(ConversationPage);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('id', wireChat.id);
    fixture.detectChanges();
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`).flush({});
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`);
    expect(fixture.nativeElement.querySelector('.message-skeleton')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.message-skeleton-avatar')).toBeNull();
    request.flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage }],
      olderCursor: wireMessage.id,
    });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.message-skeleton')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-message .chat-row.no-details')).not.toBeNull();
    dmDetails.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-message .chat-row.no-details')).toBeNull();
  });

  it('opens search from the conversation toolbar', () => {
    const button = [...fixture.nativeElement.querySelectorAll('ion-header ion-button')].find(
      (element) => element.querySelector('ion-icon')?.icon === component['toolbarIcons'].searchOutline,
    );
    expect(button).toBeDefined();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    button.click();
    expect(navigate).toHaveBeenCalledWith(['/chats/chat', wireChat.id, 'search']);
  });

  it('offers topic forwarding only while the topic holds at most 100 messages', async () => {
    await enterThread();
    const forwardButton = () =>
      [...fixture.nativeElement.querySelectorAll('ion-header ion-button')].find(
        (element: HTMLElement) => element.querySelector('ion-icon')?.icon === component['toolbarIcons'].forwardOutline,
      );
    const update = (replyCount: number) =>
      events.next({
        type: ServerWsMessageType.threadUpdate,
        payload: {
          chatId: testChat.id,
          threadRootId: encodeId('100'),
          replyCount,
          lastReplyAt: '2026-10-22T00:00:00Z',
        },
      });
    update(99);
    fixture.detectChanges();
    expect(forwardButton()).toBeDefined();
    forwardButton()!.click();
    expect(component['topicForwardOpen']()).toBe(true);
    component['topicForwardOpen'].set(false);
    update(100);
    fixture.detectChanges();
    expect(forwardButton()).toBeUndefined();
  });

  it('reads every topic message at send time and explains an oversized topic', async () => {
    await enterThread();
    const request = () =>
      http.expectOne(
        (candidate) =>
          candidate.url.endsWith(`/chats/${wireChat.id}/messages`) &&
          candidate.params.get('threadId') === '100' &&
          candidate.params.get('max') === '100',
      );
    const first = component['loadTopicSources']();
    request().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        { ...wireMessage, id: '100', clientGeneratedId: 'root-100' },
        { ...wireMessage, id: '101', clientGeneratedId: 'reply-101', replyRootId: '100' },
        {
          ...wireMessage,
          id: '102',
          clientGeneratedId: 'system-102',
          replyRootId: '100',
          messageType: MessageType.system,
        },
        {
          ...wireMessage,
          id: '103',
          clientGeneratedId: 'deleted-103',
          replyRootId: '100',
          isDeleted: true,
        },
      ],
    });
    const loading = await first;
    expect('sources' in loading && loading.sources.map((source) => forwardSourceMessage(source)?.id)).toEqual([
      encodeId('100'),
      encodeId('101'),
    ]);

    const oversized = component['loadTopicSources']();
    request().flush({ chatSettings: { showMembershipMessages: true }, messages: [], olderCursor: '99' });
    expect(await oversized).toEqual({ error: ForwardSelectionError.TooMany });

    const failed = component['loadTopicSources']();
    request().flush('failed', { status: 500, statusText: 'Server Error' });
    expect(await failed).toEqual({ error: ForwardSelectionError.LoadFailed });
  });

  it('goes back through real history from the mobile header', () => {
    const back = vi.spyOn(TestBed.inject(Location), 'back').mockImplementation(() => {});
    const button = fixture.nativeElement.querySelector(
      ':scope > ion-header ion-buttons[slot="start"] ion-button',
    ) as HTMLElement;
    button.click();
    expect(back).toHaveBeenCalledOnce();
  });

  it('hides the desktop return-to-chat button for a thread opened from the chat list', async () => {
    vi.spyOn(TestBed.inject(Location), 'getState').mockReturnValue({ fromChatList: true });
    await enterThread();
    expect(component['showBackToChat']()).toBe(false);
  });

  it('returns a directly opened conversation to the list without leaving the app', () => {
    vi.mocked(TestBed.inject(IonRouterOutlet).canGoBack).mockReturnValue(false);
    const back = vi.spyOn(TestBed.inject(Location), 'back').mockImplementation(() => {});
    const navigate = vi.spyOn(TestBed.inject(NavController), 'navigateBack').mockResolvedValue(true);
    const button = fixture.nativeElement.querySelector(
      ':scope > ion-header ion-buttons[slot="start"] ion-button',
    ) as HTMLElement;
    button.click();
    expect(back).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/chats'], { replaceUrl: true });
  });

  it('returns a directly opened thread to its parent conversation', async () => {
    await enterThread();
    vi.mocked(TestBed.inject(IonRouterOutlet).canGoBack).mockReturnValue(false);
    const back = vi.spyOn(TestBed.inject(Location), 'back').mockImplementation(() => {});
    const navigate = vi.spyOn(TestBed.inject(NavController), 'navigateBack').mockResolvedValue(true);
    component['back']();
    expect(back).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/chats/chat', wireChat.id], { replaceUrl: true });
  });

  it('returns a thread to its root message on desktop', async () => {
    await enterThread();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    component['backToChat']();
    expect(navigate).toHaveBeenCalledWith(['/chats/chat', wireChat.id], {
      replaceUrl: true,
      fragment: 'msg=100',
    });
  });

  it('opens the collapsed toolbar actions from the narrow-screen button', () => {
    const present = vi.spyOn(IonPopover.prototype, 'present').mockResolvedValue();
    component['compactToolbar'].set(true);
    fixture.detectChanges();
    const button = [...fixture.nativeElement.querySelectorAll('ion-header ion-button')].find(
      (element) => element.querySelector('ion-icon')?.icon === component['toolbarIcons'].ellipsisVertical,
    );
    expect(button).toBeDefined();
    button!.click();
    expect(present).toHaveBeenCalledOnce();
  });

  it('collapses the toolbar actions only when the full title does not fit', () => {
    const title: HTMLElement = fixture.nativeElement.querySelector('.conversation-title');
    const actions: HTMLElement = fixture.nativeElement.querySelector('ion-header ion-buttons[slot="end"]');
    const text = title.lastElementChild as HTMLElement;
    Object.defineProperty(title, 'clientWidth', { value: 300, configurable: true });
    Object.defineProperty(actions, 'offsetWidth', { value: 132, configurable: true });
    Object.defineProperties(text, {
      offsetWidth: { value: 260, configurable: true },
      scrollWidth: { value: 260, configurable: true },
    });
    component['measureToolbar']();
    expect(component['compactToolbar']()).toBe(false);
    Object.defineProperty(text, 'scrollWidth', { value: 320, configurable: true });
    component['measureToolbar']();
    expect(component['compactToolbar']()).toBe(true);
  });

  it('shares mute updates with the list and reflects websocket changes without another detail request', async () => {
    const muting = component['toggleMute']();
    await component['toggleMute'](); // A second tap while busy must not submit a duplicate.
    await vi.waitFor(() => {
      const request = http.expectOne({ method: 'PUT', url: `/_api/group/${wireChat.id}/notification-setting` });
      expect(request.request.body).toEqual({ mode: 'temporarilyMuted', durationSeconds: 3600 });
      request.flush({ mutedUntil: '9999-12-31T23:59:59Z', archived: false });
    });
    await muting;
    expect(component['muted']()).toBe(true);
    expect(TestBed.inject(ChatStore).chatState(testChat.id)?.mutedUntil).toBe('9999-12-31T23:59:59Z');
    events.next({
      type: ServerWsMessageType.chatNotificationSettingChanged,
      payload: {
        chatId: testChat.id,
        kind: GroupKind.group,
        archived: false,
        mutedUntil: undefined,
        muteOverride: false,
        isMuted: false,
      },
    });
    expect(component['muted']()).toBe(false);
  });

  it('uses shared mute state and can unmute from the conversation', async () => {
    const store = TestBed.inject(ChatStore);
    store.acceptChats([{ ...testChat, mutedUntil: '9999-12-31T23:59:59Z' }], store.snapshot());
    expect(fixture.componentInstance['muted']()).toBe(true);
    vi.mocked(IonActionSheet.prototype.onDidDismiss).mockResolvedValueOnce({
      role: 'selected',
      data: { mode: 'alwaysUnmuted' },
    });
    const unmuting = fixture.componentInstance['toggleMute']();
    await vi.waitFor(() =>
      http
        .expectOne({ method: 'PUT', url: `/_api/group/${wireChat.id}/notification-setting` })
        .flush({ mutedUntil: null, muteOverride: false }),
    );
    await unmuting;
    expect(fixture.componentInstance['muted']()).toBe(false);
  });

  it.each(['forward', 'back'] as const)(
    'animates the toolbar separately from content when navigating %s',
    (direction) => {
      const page: HTMLElement = fixture.nativeElement;
      page.classList.add('ion-page');
      const content = page.querySelector<HTMLElement>(':scope > ion-content')!;
      const title = page.querySelector<HTMLElement>(':scope > ion-header ion-title')!;
      expect(content).not.toBeNull();
      expect(title).not.toBeNull();
      const other = document.createElement('div');
      const animation = iosTransitionAnimation(document.createElement('div'), {
        baseEl: document.createElement('div'),
        enteringEl: direction === 'forward' ? page : other,
        leavingEl: direction === 'forward' ? other : page,
        direction,
      });
      const parts = [animation];
      for (const part of parts) parts.push(...part.childAnimations);
      const contentAnimation = parts.find((part) => part.elements.includes(content))!;
      const titleAnimation = parts.find((part) => part.elements.includes(title))!;
      expect(titleAnimation).not.toBe(contentAnimation);
      expect(contentAnimation.getKeyframes().some((frame) => frame['transform'])).toBe(true);
      expect(titleAnimation.getKeyframes().some((frame) => frame['transform'] && frame['opacity'] != null)).toBe(true);
      animation.destroy();
    },
  );

  function typeText(text: string) {
    const textarea = fixture.debugElement.query(By.directive(IonTextarea));
    expect((textarea.componentInstance as IonTextarea).disabled).toBeFalsy();
    textarea.nativeElement.value = text;
    textarea.nativeElement.dispatchEvent(new CustomEvent('ionInput', { bubbles: true, detail: { value: text } }));
    fixture.detectChanges();
  }

  function pendingUpload(fileName = 'edit.png') {
    const result = deferred<SnowflakeID | undefined>();
    const state = signal<{ status: UploadStatus; progress: number; id?: SnowflakeID }>({
      status: UploadStatus.Uploading,
      progress: 0.25,
    });
    const upload = {
      file: new File(['photo'], fileName, { type: 'image/png' }),
      url: `data:image/png;base64,iVBORw0KGgo=#${encodeURIComponent(fileName)}`,
      purpose: AttachmentUploadPurpose.media,
      state,
      retry: vi.fn(() => result.promise),
      dispose: vi.fn(),
    };
    return {
      upload: upload as unknown as AttachmentUpload,
      progress(value: number) {
        state.update((current) => ({ ...current, progress: value }));
      },
      finish(id: SnowflakeID) {
        state.set({ status: UploadStatus.Ready, progress: 1, id });
        result.resolve(id);
      },
    };
  }

  async function enterThread(rootId = '100', read: { lastReadMessageId?: string } = { lastReadMessageId: '101' }) {
    fixture.componentRef.setInput('threadId', rootId);
    fixture.detectChanges();
    http.expectOne(`/_api/chats/${wireChat.id}/messages/${rootId}`).flush({
      ...wireMessage,
      id: rootId,
      clientGeneratedId: `root-${rootId}`,
    });
    expect(TestBed.inject(ChatStore).loadSubscription).toHaveBeenCalledWith(testChat.id, encodeId(rootId));
    subscriptions.update((statuses) => new Map(statuses).set(encodeId(rootId), { subscribed: false, archived: false }));
    http.expectOne(`/_api/chats/${wireChat.id}/threads/${rootId}/read-state`).flush({ ...read });
    await new Promise((resolve) => setTimeout(resolve, 0));
    http
      .expectOne(
        `/_api/chats/${wireChat.id}/messages?max=50&around=${read.lastReadMessageId ?? rootId}&threadId=${rootId}`,
      )
      .flush({
        chatSettings: { showMembershipMessages: true },
        messages: [
          { ...wireMessage, id: rootId, clientGeneratedId: `root-${rootId}` },
          {
            ...wireMessage,
            id: '101',
            clientGeneratedId: `reply-${rootId}-101`,
            replyRootId: rootId,
            sender: otherSender,
          },
          {
            ...wireMessage,
            id: '102',
            clientGeneratedId: `reply-${rootId}-102`,
            replyRootId: rootId,
            sender: otherSender,
          },
        ],
      });
    await fixture.whenStable();
  }

  async function reenter() {
    component.ionViewWillEnter();
    if (component.threadId())
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(component.threadId()!)}`))
        req.flush({ ...wireMessage, id: decodeId(component.threadId()!) });
    const threadId = component.threadId();
    if (threadId) {
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(threadId)}`))
        req.flush({ ...wireMessage, id: decodeId(threadId) });
      http
        .expectOne(`/_api/chats/${wireChat.id}/threads/${decodeId(threadId)}/read-state`)
        .flush({ lastReadMessageId: '101' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    http
      .expectOne(
        `/_api/chats/${wireChat.id}/messages?max=50${threadId ? `&around=101&threadId=${decodeId(threadId)}` : ''}`,
      )
      .flush({
        chatSettings: { showMembershipMessages: true },
        messages: [{ ...wireMessage, ...(threadId ? { replyRootId: decodeId(threadId) } : {}) }],
        olderCursor: wireMessage.id,
      });
    await fixture.whenStable();
  }

  it.each(['loading', 'failed'])(
    'accepts input and renders a send before the initial page is available: %s',
    async (state) => {
      fixture.destroy();
      fixture = TestBed.createComponent(ConversationPage);
      component = fixture.componentInstance;
      fixture.componentRef.setInput('id', wireChat.id);
      fixture.detectChanges();
      const initial = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`);
      if (state === 'failed') {
        initial.flush('', { status: 503, statusText: 'Unavailable' });
        await fixture.whenStable();
        expect(component['conversation'].error()).toBe(ConversationError.Open);
      } else {
        expect(component['conversation'].loading()).toBe(true);
      }
      expect(component['conversation'].page()).toBeUndefined();
      typeText('页面未加载也能发送');
      expect(component['draft']()).toBe('页面未加载也能发送');
      const send: HTMLButtonElement = fixture.nativeElement.querySelector('.send-button');
      expect(send.disabled).toBe(false);
      send.click();
      fixture.detectChanges();
      const item = component['outbox'].items()[0];
      const operation = item.operation;
      const request = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
      expect(request.request.method).toBe('POST');
      expect(request.request.body.message).toBe('页面未加载也能发送');
      expect(component['conversation'].page()).toBeUndefined();
      expect(component['draft']()).toBe('');
      expect(component['rows']()).toHaveLength(1);
      const local = fixture.debugElement.query(By.directive(Message));
      expect(local.nativeElement.textContent).toContain('页面未加载也能发送');
      expect((local.componentInstance as Message<MessageContent>).delivery()).toBe(MessageDelivery.Sending);
      expect(component['pendingNavigation']()?.type).toBe(ConversationTargetKind.Latest);
      const latest = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`);
      if (state === 'loading') expect(initial.cancelled).toBe(true);
      typeText('继续输入下一条');
      expect((fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement).disabled).toBe(false);
      latest.flush('', { status: 503, statusText: 'Unavailable' });
      request.flush({
        ...wireMessage,
        id: '9007199254741005',
        clientGeneratedId: item.clientGeneratedId,
        message: '页面未加载也能发送',
      });
      await operation;
      await fixture.whenStable();
      expect(component['conversation'].page()).toBeUndefined();
      expect(component['conversation'].error()).toBe(ConversationError.Open);
      expect(component['rows']()).toHaveLength(1);
      expect(fixture.debugElement.query(By.directive(Message)).nativeElement).toBe(local.nativeElement);
      expect((local.componentInstance as Message<MessageContent>).message().message).toBe('页面未加载也能发送');
      expect((local.componentInstance as Message<MessageContent>).delivery()).toBe(MessageDelivery.Sent);
      expect(component['draft']()).toBe('继续输入下一条');
      expect(component['composer']()!.text()).toBe('继续输入下一条');
      typeText('加载失败后仍能继续输入');
      expect(component['draft']()).toBe('加载失败后仍能继续输入');
    },
  );

  it('encodes route IDs and prepends older messages in chronological order', async () => {
    fixture.detectChanges();
    expect(component.id()).toBe(testChat.id);
    expect(fixture.nativeElement.querySelector('app-message').getAttribute('data-message-id')).toBe(wireMessage.id);
    const loading = component['loadPage'](PageDirection.Older);
    await Promise.resolve();
    const older = { ...testMessage, id: encodeId('9007199254741001'), message: '更早的消息' };
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage, id: decodeId(older.id), message: older.message }],
      olderCursor: null,
    });
    await loading;
    expect(component['conversation'].items().map((message) => message.id)).toEqual([older.id, testMessage.id]);
  });

  it('waits for finger release and inertia before inserting an older page', async () => {
    const content: HTMLElement = fixture.nativeElement.querySelector('ion-content');
    content.dispatchEvent(new Event('touchstart'));
    content.dispatchEvent(new Event('ionScrollStart'));
    const loading = component['loadPage'](PageDirection.Older);
    await Promise.resolve();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`)
      .flush({ chatSettings: { showMembershipMessages: true }, messages: [{ ...wireMessage, id: '100' }] });
    await Promise.resolve();
    content.dispatchEvent(new Event('touchend'));
    await Promise.resolve();
    expect(component['conversation'].items()).toEqual([testMessage]);
    content.dispatchEvent(new Event('ionScrollEnd'));
    await loading;
    expect(component['conversation'].items().map((item) => item.id)).toEqual([encodeId('100'), testMessage.id]);
  });

  it('prefetches older messages within one and a half viewports', async () => {
    component.ionViewDidEnter();
    await fixture.whenStable();
    Object.defineProperties(scroll, {
      clientHeight: { value: 500 },
      scrollHeight: { value: 3000 },
    });
    scroll.scrollTop = 700;
    await component['onScroll']();
    await Promise.resolve();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`)
      .flush({ chatSettings: { showMembershipMessages: true }, messages: [{ ...wireMessage, id: '100' }] });
    await fixture.whenStable();
    expect(component['conversation'].items()).toHaveLength(2);
  });

  const testDock: VoiceDock = {
    messageId: encodeId('9007199254741003'),
    chatId: testChat.id,
    label: '张三',
    createdAt: '2026-10-16T10:00:00Z',
  };

  function stubVoiceMedia() {
    vi.stubGlobal(
      'Audio',
      class {
        preload = 'none';
        playbackRate = 1;
        play = vi.fn(async () => {});
        pause = vi.fn();
        addEventListener = () => {};
        removeEventListener = () => {};
        removeAttribute = () => {};
      },
    );
    vi.spyOn(WaveSurfer, 'create').mockReturnValue({
      on: () => {},
      load: () => Promise.resolve(),
      destroy: () => {},
    } as unknown as WaveSurfer);
  }

  function pinMessage(id: string, message = testMessage) {
    events.next({
      type: component.threadId() ? ServerWsMessageType.threadPinAdded : ServerWsMessageType.pinAdded,
      payload: {
        chatId: testChat.id,
        threadRootId: component.threadId(),
        messageId: message.id,
        pinId: encodeId(id),
        pin: { id: encodeId(id), chatId: testChat.id, message, pinnedBy: 1, pinnedAt: message.createdAt },
      },
    });
  }

  it('keeps the current messages while locating a pin and clears feedback after failure', async () => {
    const older = { ...testMessage, id: encodeId('100') };
    pinMessage('201', older);
    fixture.detectChanges();
    const list = fixture.nativeElement.querySelector('.message-list');
    const pending = component['locatePin']();
    fixture.detectChanges();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.pinned-preview');
    expect(button.disabled).toBe(true);
    expect(button.querySelector('ion-spinner')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.message-list')).toBe(list);
    expect(component['conversation'].items()).toEqual([testMessage]);
    await component['locatePin']();
    http
      .expectOne((req) => req.url.endsWith('/messages') && req.params.get('around') === '100')
      .flush('', { status: 503, statusText: 'Unavailable' });
    await pending;
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    expect(button.querySelector('ion-spinner')).toBeNull();
    expect(component['selectedPin']()?.message.id).toBe(older.id);
    expect(fixture.nativeElement.querySelector('.message-list')).toBe(list);
  });

  it('shows pins below the title, cycles navigation and removes the bar when unpinned', async () => {
    expect(TestBed.inject(PinsService).listPins).toHaveBeenCalledWith(testChat.id);
    expect(fixture.nativeElement.querySelector('.pinned-bar')).toBeNull();
    pinMessage('201');
    const newer = { ...testMessage, id: encodeId('9007199254741010'), message: '较新的置顶' };
    pinMessage('202', newer);
    await fixture.whenStable();
    const bar: HTMLElement = fixture.nativeElement.querySelector('.pinned-bar');
    expect(bar.previousElementSibling?.tagName).toBe('ION-TOOLBAR');
    expect(bar.textContent).toContain('较新的置顶');
    const jump = vi
      .spyOn(component as unknown as { goTo: (typeof component)['goTo'] }, 'goTo')
      .mockResolvedValue(undefined);
    await component['locatePin']();
    expect(jump).toHaveBeenCalledWith({ type: ConversationTargetKind.Message, messageId: newer.id });
    expect(component['selectedPin']()?.message.id).toBe(testMessage.id);
    await component['locatePin']();
    expect(component['selectedPin']()?.message.id).toBe(newer.id);
    for (const id of ['201', '202'])
      events.next({
        type: ServerWsMessageType.pinRemoved,
        payload: { chatId: testChat.id, pinId: encodeId(id), messageId: testMessage.id },
      });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.pinned-bar')).toBeNull();
  });

  function unpinMessage(id: string) {
    events.next({
      type: component.threadId() ? ServerWsMessageType.threadPinRemoved : ServerWsMessageType.pinRemoved,
      payload: {
        chatId: testChat.id,
        threadRootId: component.threadId(),
        pinId: encodeId(id),
        messageId: testMessage.id,
      },
    });
  }

  it.each(['touchEnd', 'scrollEnd'] as const)(
    'defers pin bar appearance and removal until both touch and scrolling end: %s first',
    async (firstEnd) => {
      const scrolling = component['scrolling'];
      const secondEnd = firstEnd === 'touchEnd' ? 'scrollEnd' : 'touchEnd';
      for (const show of [true, false]) {
        scrolling.touchStart();
        scrolling.scrollStart();
        if (show) pinMessage('201');
        else unpinMessage('201');
        await fixture.whenStable();
        expect(component['pins']().items()).toHaveLength(show ? 1 : 0);
        expect(!!fixture.nativeElement.querySelector('.pinned-bar')).toBe(!show);
        scrolling[firstEnd]();
        await fixture.whenStable();
        expect(!!fixture.nativeElement.querySelector('.pinned-bar')).toBe(!show);
        scrolling[secondEnd]();
        await fixture.whenStable();
        expect(!!fixture.nativeElement.querySelector('.pinned-bar')).toBe(show);
      }
    },
  );

  it.each([false, true])('coalesces pin changes while scrolling with an initially visible bar: %s', async (shown) => {
    if (shown) pinMessage('201');
    await fixture.whenStable();
    const bar = fixture.nativeElement.querySelector('.pinned-bar');
    component['scrolling'].scrollStart();
    if (shown) unpinMessage('201');
    else pinMessage('201');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.pinned-bar')).toBe(bar);
    if (shown) pinMessage('201');
    else unpinMessage('201');
    await fixture.whenStable();
    component['scrolling'].scrollEnd();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.pinned-bar')).toBe(bar);
  });

  it('updates an existing pin preview during scrolling without replacing the bar', async () => {
    pinMessage('201');
    await fixture.whenStable();
    const bar: HTMLElement = fixture.nativeElement.querySelector('.pinned-bar');
    component['scrolling'].scrollStart();
    pinMessage('201', { ...testMessage, message: '修改后的置顶内容' });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.pinned-bar')).toBe(bar);
    expect(bar.textContent).toContain('修改后的置顶内容');
  });

  it('docks a playing message voice into the header bar and keeps it across page switches', async () => {
    stubVoiceMedia();
    const player = TestBed.createComponent(VoicePlayer);
    player.componentRef.setInput('src', '/voice.ogg');
    player.componentRef.setInput('dock', { ...testDock });
    player.detectChanges();
    expect(fixture.nativeElement.querySelector('.voice-bar')).toBeNull();
    player.componentInstance.toggle();
    fixture.detectChanges();
    const bar: HTMLElement = fixture.nativeElement.querySelector('.voice-bar');
    expect(bar).not.toBeNull();
    expect(bar.querySelector('.voice-name')?.textContent).toBe('张三');
    expect(bar.querySelector('.voice-date')?.textContent).toContain('10月16日');
    bar.querySelector<HTMLButtonElement>('.voice-speed')!.click();
    expect(TestBed.inject(VoicePlayback).rate()).toBe(1.5);
    // Switching conversations destroys the message rows; the bar keeps controlling the voice.
    player.destroy();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.voice-bar')).toBe(bar);
    bar.querySelector<HTMLButtonElement>('.voice-button')!.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.voice-bar')).toBe(bar);
    (fixture.nativeElement.querySelector('.voice-bar ion-button') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.voice-bar')).toBeNull();
    expect(TestBed.inject(VoicePlayback).active()).toBeUndefined();
  });

  it('opens the docked voice conversation from the bar label', () => {
    stubVoiceMedia();
    const open = vi.spyOn(TestBed.inject(ConversationNavigation), 'open').mockResolvedValue(true);
    const player = TestBed.createComponent(VoicePlayer);
    player.componentRef.setInput('src', '/voice.ogg');
    player.componentRef.setInput('dock', { ...testDock });
    player.detectChanges();
    player.componentInstance.toggle();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.voice-bar .voice-label') as HTMLElement).click();
    expect(open).toHaveBeenCalledWith(testDock.chatId, undefined, testDock.messageId);
    player.destroy();
    // The voice is adopted and keeps playing even though its player is gone.
    const orphan = TestBed.inject(VoicePlayback).active()!;
    expect(orphan).not.toBe(player.componentInstance);
    expect(orphan.playing()).toBe(true);
    orphan.dismiss();
    expect(TestBed.inject(VoicePlayback).active()).toBeUndefined();
  });

  it('discards deferred pin visibility on topic changes and uses current pins on cached reentry', async () => {
    component['scrolling'].touchStart();
    component['scrolling'].scrollStart();
    pinMessage('201');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.pinned-bar')).toBeNull();
    await enterThread();
    expect(fixture.nativeElement.querySelector('.pinned-bar')).toBeNull();
    component['scrolling'].scrollStart();
    pinMessage('202');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.pinned-bar')).toBeNull();
    component.ionViewDidLeave();
    unpinMessage('202');
    await reenter();
    expect(fixture.nativeElement.querySelector('.pinned-bar')).toBeNull();
    pinMessage('203');
    await fixture.whenStable();
    expect(component['selectedPin']()?.id).toBe(encodeId('203'));
  });

  it('uses this topic pin collection and resets the selected preview on entry', async () => {
    pinMessage('201');
    await enterThread();
    expect(TestBed.inject(PinsService).listThreadPins).toHaveBeenCalledWith(testChat.id, encodeId('100'));
    expect(component['selectedPin']()).toBeUndefined();
    pinMessage('202');
    await fixture.whenStable();
    const link = fixture.debugElement.query(By.directive(RouterLink)).injector.get(RouterLink).urlTree!;
    expect(TestBed.inject(Router).serializeUrl(link)).toBe(`/chats/chat/${wireChat.id}/thread/100/pins`);
  });

  it('keeps the fixed button mounted while scrolling across the latest-message threshold', async () => {
    await component['positionAndRead']();
    await fixture.whenStable();
    Object.defineProperties(scroll, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 500 },
    });
    scroll.scrollTop = 200;
    await component['onScroll']();
    await fixture.whenStable();
    const content: HTMLElement = fixture.nativeElement.querySelector('ion-content');
    const fab: HTMLElement = content.querySelector('ion-fab')!;
    expect(fab).not.toBeNull();
    for (const top of [470, 200, 470]) {
      scroll.scrollTop = top;
      await component['onScroll']();
      await fixture.whenStable();
      expect(content.querySelector('ion-fab')).toBe(fab);
      expect(fab.querySelector<HTMLElement>('.down-navigation')!.hidden).toBe(top === 470);
      expect(scroll.scrollTop).toBe(top);
    }
  });

  it('keeps the floating date and content slots mounted across scrolling starts, date changes and stops', async () => {
    const content: HTMLElement = fixture.nativeElement.querySelector('ion-content');
    const children = [...content.children];
    const date = content.querySelector<HTMLElement>('.floating-date')!;
    expect(date.classList.contains('scrolling')).toBe(false);
    for (const day of ['2026-09-08', '2026-09-09']) {
      component['visibleDate'].set(`${day}T00:00:00Z`);
      content.dispatchEvent(new Event('ionScrollStart'));
      await fixture.whenStable();
      expect([...content.children]).toEqual(children);
      expect(content.querySelector('.floating-date')).toBe(date);
      expect(date.classList.contains('scrolling')).toBe(true);
      content.dispatchEvent(new Event('ionScrollEnd'));
      await fixture.whenStable();
      expect([...content.children]).toEqual(children);
      expect(date.classList.contains('scrolling')).toBe(false);
    }
  });

  it('yields to a date separator crossing the floating label and restores the label afterwards', async () => {
    const separator: HTMLElement = fixture.nativeElement.querySelector('.message-date');
    const floating: HTMLElement = fixture.nativeElement.querySelector('.floating-date');
    const message: HTMLElement = fixture.nativeElement.querySelector('app-message');
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    Object.defineProperties(floating, { offsetTop: { value: 12 }, offsetHeight: { value: 25 } });
    vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 50, 300, 100));
    const dateRect = vi.spyOn(separator, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 12, 300, 40));
    component.ionViewWillEnter();
    component.ionViewDidEnter();
    component['scrolling'].scrollStart();
    await component['trackScroll']();
    fixture.detectChanges();
    expect(floating.classList.contains('colliding')).toBe(true);
    expect(separator.style.visibility).toBe('visible');
    dateRect.mockReturnValue(new DOMRect(0, -50, 300, 40));
    await component['trackScroll']();
    fixture.detectChanges();
    expect(floating.classList.contains('colliding')).toBe(false);
    expect(floating.classList.contains('scrolling')).toBe(true);
    expect(separator.style.visibility).toBe('hidden');
    component['scrolling'].scrollEnd();
    fixture.detectChanges();
    expect(separator.style.visibility).toBe('visible');
  });

  it.each([false, true])('hides the down button until initial positioning (newer page: %s)', async (hasNewer) => {
    const positioning = vi
      .spyOn(component as unknown as { positionAndRead(): Promise<void> }, 'positionAndRead')
      .mockResolvedValue();
    component['activate'](testChat.id);
    await fixture.whenStable();
    expect(component['showDownButton']()).toBe(false);
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage }],
      olderCursor: wireMessage.id,
      ...(hasNewer ? { newerCursor: wireMessage.id } : {}),
    });
    await fixture.whenStable();
    fixture.detectChanges();
    const button: HTMLElement = fixture.nativeElement.querySelector('.down-navigation');
    expect(button.hidden).toBe(true);
    positioning.mockRestore();
    await component['positionAndRead']();
    await fixture.whenStable();
    expect(button.hidden).toBe(!hasNewer);
    Object.defineProperties(scroll, { scrollHeight: { value: 3000 }, clientHeight: { value: 500 } });
    scroll.scrollTop = 1000;
    await component['trackScroll']();
    await fixture.whenStable();
    expect(button.hidden).toBe(false);
    expect(fixture.nativeElement.querySelector('.down-navigation')).toBe(button);
  });

  it('reads the badge from shared state, keeps its node mounted and hides it with the button', async () => {
    const data = TestBed.inject(ChatStore);
    const badge: HTMLElement = fixture.nativeElement.querySelector('.down-navigation ion-badge');
    data.acceptChats([{ ...testChat, unreadCount: 37 }], data.snapshot());
    Object.defineProperties(scroll, { scrollHeight: { value: 3000 }, clientHeight: { value: 500 } });
    scroll.scrollTop = 1000;
    await component['trackScroll']();
    await fixture.whenStable();
    expect(badge.textContent?.trim()).toBe('37');
    expect(badge.style.opacity).toBe('1');
    expect(component['showDownButton']()).toBe(true);
    component['composer']()!.voiceActive.set(true);
    expect(component['showDownButton']()).toBe(false);
    component['composer']()!.voiceActive.set(false);
    data.acceptChats([{ ...testChat, unreadCount: 0 }], data.snapshot());
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.down-navigation ion-badge')).toBe(badge);
    expect(badge.style.opacity).toBe('0');
  });

  it('uses topic counts without mixing in the parent chat or fetching the thread list', async () => {
    const data = TestBed.inject(ChatStore);
    data.acceptChats([{ ...testChat, unreadCount: 37 }], data.snapshot());
    data.acceptThreads(
      [
        {
          chatId: testChat.id,
          threadRootMessage: { ...testMessage, mentions: [] },
          chatKind: testChat.kind,
          chatName: '测试群',
          participants: [],
          replyCount: 5,
          subscribedAt: testMessage.createdAt,
          archived: false,
          unreadCount: 5,
          unreadMentions: 0,
          unreadReactions: 0,
          lastReadMessageId: testMessage.id,
          lastReplyAt: testMessage.createdAt,
        },
      ],
      data.snapshot(),
      data.subscriptionSnapshot(),
    );
    expect(data.unreadCount(testChat.id, testMessage.id)).toBe(5);
    expect(data.unreadCount(testChat.id, encodeId('999'))).toBe(0);
    expect(data.unreadCount(testChat.id)).toBe(37);
    http.expectNone(() => true);
  });

  it('returns through nested reply jumps before going to the latest loaded messages', async () => {
    Object.defineProperty(Element.prototype, 'animate', { value: vi.fn(), configurable: true });
    try {
      const opening = component['conversation'].open(encodeId('200'));
      http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=200`).flush({
        chatSettings: { showMembershipMessages: true },
        messages: [100, 200, 300].map((id) => ({ ...wireMessage, id: String(id) })),
      });
      await opening;
      await fixture.whenStable();
      fixture.debugElement.queryAll(By.directive(Message))[2].componentInstance.jump.emit(encodeId('200'));
      await fixture.whenStable();
      fixture.debugElement.queryAll(By.directive(Message))[1].componentInstance.jump.emit(encodeId('100'));
      await fixture.whenStable();
      expect(component['returnMessageIds']()).toEqual([encodeId('300'), encodeId('200')]);
      await component['navigateDown']();
      expect(component['returnMessageIds']()).toEqual([encodeId('300')]);
      await component['navigateDown']();
      expect(component['returnMessageIds']()).toEqual([]);
      await component['navigateDown']();
      expect(component['navigatingDown']()).toBe(false);
      http.expectNone(() => true);
      component.ionViewDidLeave();
      expect(component['returnMessageIds']()).toEqual([]);
    } finally {
      fixture.destroy();
      Reflect.deleteProperty(Element.prototype, 'animate');
    }
  });

  it('retains a failed return for retry and skips a deleted return target', async () => {
    component['returnMessageIds'].set([encodeId('300')]);
    const returning = component['navigateDown']();
    expect(component['navigatingDown']()).toBe(true);
    expect(component['pendingNavigation']()).toEqual({
      type: ConversationTargetKind.Message,
      messageId: encodeId('300'),
    });
    await component['navigateDown']();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=300`)
      .flush('', { status: 503, statusText: 'Unavailable' });
    await returning;
    expect(component['navigatingDown']()).toBe(false);
    expect(component['returnMessageIds']()).toEqual([encodeId('300')]);
    const retrying = component['navigateDown']();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=300`)
      .flush({ chatSettings: { showMembershipMessages: true }, messages: [{ ...wireMessage, id: '299' }] });
    await retrying;
    expect(component['returnMessageIds']()).toEqual([]);
    expect(component['conversation'].error()).toBe(ConversationError.Missing);
    await component['navigateDown']();
    expect(component['conversation'].error()).toBeUndefined();
    http.expectNone(() => true);
  });

  it('forgets return points reached by manual scrolling and on leaving the conversation', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    const element: HTMLElement = fixture.nativeElement.querySelector('app-message');
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 20, 300, 100));
    const later = encodeId('9007199254741999');
    component['returnMessageIds'].set([later, testMessage.id]);
    component.ionViewDidEnter();
    await component['trackScroll']();
    expect(component['returnMessageIds']()).toEqual([later]);
    component.ionViewDidLeave();
    expect(component['returnMessageIds']()).toEqual([]);
  });

  async function openUnreadHistory() {
    const opening = component['conversation'].open(encodeId('100'));
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=100`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [100, 101, 102].map((id) => ({
        ...wireMessage,
        id: String(id),
        clientGeneratedId: `unread-${id}`,
        ...(id === 100 ? {} : { sender: otherSender }),
      })),
      newerCursor: '102',
    });
    await opening;
    await fixture.whenStable();
  }

  /** Places message 101 at offsetTop inside a viewport spanning 0..500. */
  function mockUnreadStartAt(offsetTop: number) {
    Object.defineProperties(scroll, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
    scroll.scrollTop = 0;
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-message-id') === '101'
        ? new DOMRect(0, offsetTop, 300, 60)
        : new DOMRect(0, 0, 300, 0);
    });
  }

  it('stops at the live unread start before reaching the latest messages', async () => {
    const data = TestBed.inject(ChatStore);
    data.acceptChats([{ ...testChat, unreadCount: 2, lastReadMessageId: encodeId('100') }], data.snapshot());
    await openUnreadHistory();
    mockUnreadStartAt(900);
    expect(component['unreadStartId']()).toBe(encodeId('101'));
    await component['navigateDown']();
    await component['positionAndRead']();
    expect(scroll.scrollTop).toBe(900);
    expect(component['navigatingDown']()).toBe(false);
    http.expectNone(() => true);
  });

  it('keeps going to the latest messages when the unread start is already on screen', async () => {
    const data = TestBed.inject(ChatStore);
    data.acceptChats([{ ...testChat, unreadCount: 2, lastReadMessageId: encodeId('100') }], data.snapshot());
    await openUnreadHistory();
    mockUnreadStartAt(100);
    const navigating = component['navigateDown']();
    await vi.waitFor(() =>
      http
        .expectOne(`/_api/chats/${wireChat.id}/messages?max=50`)
        .flush({ chatSettings: { showMembershipMessages: true }, messages: [{ ...wireMessage }] }),
    );
    await navigating;
    expect(component['conversation'].page()?.messages).toEqual([testMessage]);
  });

  it('ignores the frozen divider once the unread messages have been read', async () => {
    const data = TestBed.inject(ChatStore);
    await openUnreadHistory();
    component['entryReadId'].set(encodeId('100'));
    data.acceptChats([{ ...testChat, unreadCount: 0, lastReadMessageId: encodeId('102') }], data.snapshot());
    expect(component['firstUnreadId']()).toBe(encodeId('101'));
    expect(component['unreadStartId']()).toBeUndefined();
    const navigating = component['navigateDown']();
    await vi.waitFor(() =>
      http
        .expectOne(`/_api/chats/${wireChat.id}/messages?max=50`)
        .flush({ chatSettings: { showMembershipMessages: true }, messages: [{ ...wireMessage }] }),
    );
    await navigating;
    expect(component['conversation'].page()?.messages).toEqual([testMessage]);
  });

  it('returns through a reply jump before stopping at the unread start', async () => {
    const data = TestBed.inject(ChatStore);
    data.acceptChats([{ ...testChat, unreadCount: 2, lastReadMessageId: encodeId('100') }], data.snapshot());
    await openUnreadHistory();
    mockUnreadStartAt(900);
    component['returnMessageIds'].set([encodeId('300')]);
    const navigating = component['navigateDown']();
    await vi.waitFor(() =>
      http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=300`).flush({
        chatSettings: { showMembershipMessages: true },
        messages: [{ ...wireMessage, id: '300' }],
      }),
    );
    await navigating;
    expect(component['returnMessageIds']()).toEqual([]);
  });

  it('refreshes an offscreen conversation count on incoming messages without jumping down', async () => {
    const data = TestBed.inject(ChatStore);
    component['atBottom'].set(false);
    incoming.next({ ...testMessage, id: encodeId('9007199254741999') });
    await notificationSettled();
    expect(data.getReadState).toHaveBeenCalledWith(testChat.id);
    expect(component['position']()).toBeUndefined();
  });

  it.each([200, 200.9765625])(
    'preserves the message bottom when prepending %s px and removing its author header',
    async (prependedHeight) => {
      await component['positionAndRead']();
      await fixture.whenStable();
      const message: HTMLElement = fixture.nativeElement.querySelector('app-message');
      scroll.scrollTop = 80;
      vi.spyOn(message, 'getBoundingClientRect').mockImplementation(() => {
        const prepended = fixture.nativeElement.querySelectorAll('app-message').length > 1;
        return new DOMRect(
          0,
          100 + (prepended ? prependedHeight : 0) - scroll.scrollTop,
          300,
          message.querySelector('.sender') ? 64 : 44,
        );
      });
      const bottom = message.getBoundingClientRect().bottom;
      const loading = component['loadPage'](PageDirection.Older);
      await Promise.resolve();
      http
        .expectOne((req) => req.url.endsWith('/messages') && req.params.has('before'))
        .flush({
          chatSettings: { showMembershipMessages: true },
          messages: [{ ...wireMessage, id: '100', clientGeneratedId: 'older-100' }],
          olderCursor: '100',
        });
      await loading;
      await fixture.whenStable();
      expect(message.querySelector('.sender')).toBeNull();
      expect(message.getBoundingClientRect().height).toBe(44);
      expect(message.getBoundingClientRect().bottom).toBe(bottom);
      expect(scroll.scrollTop).toBe(80 + prependedHeight - 20);
    },
  );

  it('keeps the pagination button and content slots mounted while loading older messages', async () => {
    await component['positionAndRead']();
    await fixture.whenStable();
    const content: HTMLElement = fixture.nativeElement.querySelector('ion-content');
    const children = [...content.children];
    const button = content.querySelector('button.pagination-control')!;
    expect(button.textContent?.trim()).toBe('');
    expect(button.querySelector('ion-icon')).not.toBeNull();
    expect(button.querySelector('ion-spinner')).toBeNull();
    scroll.scrollTop = 50;
    const loading = component['loadPage'](PageDirection.Older);
    await Promise.resolve();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`);
    await fixture.whenStable();
    expect(component['conversation'].pagingDirection()).toBe(PageDirection.Older);
    expect(button.querySelector('ion-icon')).toBeNull();
    expect(button.querySelector('ion-spinner')).not.toBeNull();
    expect([...content.children]).toEqual(children);
    expect(scroll.scrollTop).toBe(50);
    request.flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage, id: '9007199254741001' }],
      olderCursor: '9007199254741001',
    });
    await loading;
    await fixture.whenStable();
    expect([...content.children]).toEqual(children);
    expect(button.querySelector('ion-icon')).not.toBeNull();
    expect(button.querySelector('ion-spinner')).toBeNull();
    expect(component['conversation'].items()).toHaveLength(2);
  });

  it('confirms unpin in the normal message menu before removing it', async () => {
    TestBed.inject(ChatStore).invalidate();
    const details = TestBed.inject(ChatStore).ensureDetails(testChat.id);
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...structuredClone(wireChat), myRole: GroupRole.admin });
    const pinId = encodeId('200');
    events.next({
      type: ServerWsMessageType.pinAdded,
      payload: {
        chatId: testChat.id,
        messageId: testMessage.id,
        pinId,
        pin: { id: pinId, chatId: testChat.id, pinnedAt: testMessage.createdAt, pinnedBy: 1, message: testMessage },
      },
    });
    await details;
    const select = () =>
      component['menu']()!['selection'].set({
        messageId: testMessage.id,
        element: document.createElement('div'),
        rect: new DOMRect(),
        own: false,
      });
    select();
    await component['menu']()!['choose'](MessageAction.Pin);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-message-menu ion-alert').header).toBe('取消置顶');
    expect(fixture.nativeElement.querySelector('app-message-menu ion-alert').isOpen).toBe(true);
    http.expectNone((request) => request.method === 'DELETE');
    await component['menu']()!['confirm'](new CustomEvent('didDismiss', { detail: { role: 'cancel' } }));
    expect(component['pins']().items()).toHaveLength(1);
    select();
    await component['menu']()!['choose'](MessageAction.Pin);
    const removing = component['menu']()!['confirm'](new CustomEvent('didDismiss', { detail: { role: 'confirm' } }));
    await Promise.resolve();
    http.expectOne(`/_api/chats/${wireChat.id}/pins/200`).flush(null);
    await removing;
    expect(component['menu']()!['notice']()).toBe(MessageNotice.Unpinned);
  });

  it('blocks pin actions when membership no longer permits them', async () => {
    TestBed.inject(ChatStore).invalidate();
    const details = TestBed.inject(ChatStore).ensureDetails(testChat.id);
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...structuredClone(wireChat), myRole: GroupRole.member });
    await details;
    component['menu']()!['selection'].set({
      messageId: testMessage.id,
      element: document.createElement('div'),
      rect: new DOMRect(),
      own: false,
    });
    await component['menu']()!['choose'](MessageAction.Pin);
    expect(component['menu']()!['confirmation']()).toBeUndefined();
    component['menu']()!['confirmation'].set({ action: MessageAction.Pin, message: testMessage, pinned: true });
    await component['menu']()!['confirm'](new CustomEvent('didDismiss', { detail: { role: 'confirm' } }));
    http.expectNone((request) => request.url.includes('/pins'));
    component['menu']()!['selection'].set(undefined);
  });

  it('saves the previous draft on navigation and ignores the old conversation pagination response', async () => {
    component['draft'].set('旧会话草稿');
    const loading = component['loadPage'](PageDirection.Older);
    await Promise.resolve();
    const oldPage = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`);
    fixture.componentRef.setInput('id', '9007199254740995');
    fixture.detectChanges();
    http.expectOne('/_api/group/9007199254740995').flush({ ...wireChat, id: '9007199254740995' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    http
      .expectOne('/_api/chats/9007199254740995/messages?max=50')
      .flush({ chatSettings: { showMembershipMessages: true }, messages: [], olderCursor: null });
    await Promise.resolve();
    fixture.detectChanges();
    expect(oldPage.cancelled).toBe(true);
    await loading;
    expect(component['conversation'].items()).toEqual([]);
    expect(component['draft']()).toBe('');
    expect(TestBed.inject(DraftStore).get(testChat.id)?.text).toBe('旧会话草稿');
    expect(TestBed.inject(DraftStore).get(encodeId('9007199254740995'))).toBeUndefined();
  });

  it('reuses the parent message and avatar when returning from a topic, then merges missed messages', async () => {
    const router = TestBed.inject(Router);
    const parent = `/chats/chat/${wireChat.id}`;
    const url = vi.spyOn(router, 'url', 'get').mockReturnValue(`${parent}/thread/${wireMessage.id}`);
    const row = fixture.nativeElement.querySelector('app-message');
    const avatar = row.querySelector('ion-avatar');
    expect(avatar).not.toBeNull();
    component['updateDraft']('群里的草稿');
    component.ionViewWillLeave();
    component.ionViewDidLeave();
    expect(component['active']()).toBe(false);
    expect(fixture.nativeElement.querySelector('app-message')).toBe(row);
    expect(row.querySelector('ion-avatar')).toBe(avatar);
    const reading = vi.mocked(TestBed.inject(ChatStore).markRead);
    reading.mockClear();
    await component['trackScroll']();
    expect(reading).not.toHaveBeenCalled();

    url.mockReturnValue(parent);
    component.ionViewWillEnter();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-message')).toBe(row);
    expect(row.querySelector('ion-avatar')).toBe(avatar);
    expect(component['draft']()).toBe('群里的草稿');
    expect(fixture.nativeElement.querySelector('.message-skeleton')).toBeNull();
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&after=${wireMessage.id}`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        {
          ...wireMessage,
          id: '9007199254741010',
          clientGeneratedId: 'missed-in-topic',
          message: '新消息',
          sender: { ...wireMessage.sender, uid: wireMessage.sender.uid + 1 },
        },
      ],
    });
    await vi.waitFor(() => expect(component['conversation'].items()).toHaveLength(2));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-message')).toBe(row);
    expect(row.querySelector('ion-avatar')).toBe(avatar);
  });

  it('releases a covered parent when navigation leaves its group and topics', () => {
    const router = TestBed.inject(Router);
    const url = vi.spyOn(router, 'url', 'get').mockReturnValue(`/chats/chat/${wireChat.id}/thread/${wireMessage.id}`);
    component.ionViewDidLeave();
    expect(component['conversation'].items()).toHaveLength(1);
    url.mockReturnValue('/chats');
    (router.events as Subject<NavigationEnd>).next(new NavigationEnd(1, '/chats', '/chats'));
    expect(component['conversation'].page()).toBeUndefined();
    expect(fixture.nativeElement.querySelector('app-message')).toBeNull();
  });

  it('keeps typing and reply selection local, persisting once when navigation starts', () => {
    const drafts = TestBed.inject(DraftStore);
    const write = vi.spyOn(window.localStorage, 'setItem');
    for (const text of ['未', '未发', '未发送']) component['updateDraft'](text);
    component['startReply'](testMessage);
    expect(drafts.get(testChat.id)).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    component.ionViewWillLeave();
    expect(drafts.get(testChat.id)).toMatchObject({ text: '未发送', replyTo: wireMessage.id });
    expect(write).toHaveBeenCalledOnce();
    component.ionViewDidLeave();
    expect(write).toHaveBeenCalledOnce();
  });

  it('saves on backgrounding or pagehide, without saving on a visible event or after leaving', () => {
    const drafts = TestBed.inject(DraftStore);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    component['updateDraft']('后台保留');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(drafts.get(testChat.id)).toBeUndefined();
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(drafts.get(testChat.id)?.text).toBe('后台保留');
    component['updateDraft']('刷新保留');
    window.dispatchEvent(new Event('pagehide'));
    const saved = drafts.get(testChat.id);
    expect(saved?.text).toBe('刷新保留');
    component.ionViewDidLeave();
    window.dispatchEvent(new Event('pagehide'));
    expect(drafts.get(testChat.id)).toBe(saved);
  });

  it('retains unsent text when cancelling an edit and saves that text when leaving during another edit', () => {
    const drafts = TestBed.inject(DraftStore);
    component['updateDraft']('还没有发送');
    component['startReply'](testMessage);
    component['startEdit'](testMessage);
    component['updateDraft']('编辑已发送的消息');
    expect(drafts.get(testChat.id)).toBeUndefined();
    expect(component['draft']()).toBe('还没有发送');
    component['cancelEdit']();
    expect(component['draft']()).toBe('还没有发送');
    component['startEdit'](testMessage);
    component['updateDraft']('另一次编辑');
    component.ionViewWillLeave();
    expect(drafts.get(testChat.id)).toMatchObject({ text: '还没有发送', replyTo: wireMessage.id });
  });

  it('Escape cancels an unchanged edit or the reply and blurs the composer otherwise', () => {
    const blur = vi.spyOn(component['composer']()!, 'blur').mockImplementation(() => {});
    component['startReply'](testMessage);
    component['escapeComposer']();
    expect(component['replyTo']()).toBeUndefined();
    expect(blur).not.toHaveBeenCalled();

    component['startEdit'](testMessage);
    component['escapeComposer']();
    expect(component['editTarget']()).toBeUndefined();

    component['startEdit'](testMessage);
    component['updateDraft']('改动过的编辑');
    component['escapeComposer']();
    expect(component['editTarget']()).toBeDefined();

    component['cancelEdit']();
    component['escapeComposer']();
    expect(blur).toHaveBeenCalledOnce();
  });

  it.each(['background', 'transition', 'left'])(
    'persists only the next draft while an earlier send finishes: %s',
    async (mode) => {
      const drafts = TestBed.inject(DraftStore);
      component['updateDraft']('正在发送');
      const sending = component['sendMessage']();
      const request = http.expectOne((req) => req.method === 'POST' && req.url.endsWith('/messages'));
      expect(component['draft']()).toBe('');
      expect(drafts.get(testChat.id)).toBeUndefined();
      component['updateDraft']('下一条草稿');
      component['startReply'](testMessage);
      if (mode === 'background') {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
      } else {
        component.ionViewWillLeave();
        vi.mocked(TestBed.inject(Router).isActive).mockReturnValue(false);
        if (mode === 'left') component.ionViewDidLeave();
      }
      const saved = drafts.get(testChat.id);
      expect(saved).toMatchObject({ text: '下一条草稿', replyTo: wireMessage.id });
      request.flush({
        ...wireMessage,
        id: '9007199254741005',
        clientGeneratedId: request.request.body.clientGeneratedId,
        message: '正在发送',
      });
      await sending;
      expect(drafts.get(testChat.id)).toBe(saved);
      if (mode !== 'left') {
        expect(component['draft']()).toBe('下一条草稿');
        expect(component['replyTo']()).toBe(testMessage);
      }
      component.ionViewDidLeave();
      expect(drafts.get(testChat.id)).toBe(saved);
    },
  );

  it('restores a draft after leaving and clears persisted text as soon as it is enqueued', async () => {
    component['updateDraft']('保留草稿');
    component.ionViewDidLeave();
    component.ionViewWillEnter();
    if (component.threadId())
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(component.threadId()!)}`))
        req.flush({ ...wireMessage, id: decodeId(component.threadId()!) });
    await fixture.whenStable();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50`)
      .flush({ chatSettings: { showMembershipMessages: true }, messages: [structuredClone(wireMessage)] });
    await fixture.whenStable();
    expect(component['draft']()).toBe('保留草稿');
    const sending = component['sendMessage']();
    expect(component['draft']()).toBe('');
    expect(TestBed.inject(DraftStore).get(testChat.id)).toBeUndefined();
    const request = http.expectOne((req) => req.method === 'POST' && req.url.endsWith('/messages'));
    request.flush({
      ...wireMessage,
      id: '9007199254741005',
      clientGeneratedId: request.request.body.clientGeneratedId,
      message: '保留草稿',
    });
    await sending;
    expect(TestBed.inject(DraftStore).get(testChat.id)).toBeUndefined();
  });

  it('preserves the reply ID while typing during draft restoration and does not restore a cancelled reply', async () => {
    const drafts = TestBed.inject(DraftStore);
    component.ionViewDidLeave();
    drafts.save(testChat.id, undefined, '回复草稿', testMessage.id);
    component.ionViewWillEnter();
    if (component.threadId())
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(component.threadId()!)}`))
        req.flush({ ...wireMessage, id: decodeId(component.threadId()!) });
    await fixture.whenStable();
    const replyRequest = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`);
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50`)
      .flush({ chatSettings: { showMembershipMessages: true }, messages: [structuredClone(wireMessage)] });
    component['updateDraft']('继续编辑');
    expect(drafts.get(testChat.id)?.replyTo).toBe(wireMessage.id);
    component['cancelReply']();
    replyRequest.flush(structuredClone(wireMessage));
    await fixture.whenStable();
    expect(component['replyTo']()).toBeUndefined();
    expect(drafts.get(testChat.id)).toMatchObject({ text: '回复草稿', replyTo: wireMessage.id });
    component.ionViewWillLeave();
    expect(drafts.get(testChat.id)).toMatchObject({ text: '继续编辑', replyTo: undefined });
  });

  it('keeps a failed row in the root outbox across leaving and reentry without restoring submitted input', async () => {
    component['updateDraft']('待重试');
    const sending = component['sendMessage']();
    const item = component['outbox'].items()[0];
    expect(component['draft']()).toBe('');
    expect(component['rows']().at(-1)?.outgoing).toBe(item);
    http.expectOne(`/_api/chats/${wireChat.id}/messages`).flush('', { status: 503, statusText: 'Unavailable' });
    await sending;
    fixture.detectChanges();
    const row: HTMLElement = fixture.nativeElement.querySelector('app-message:last-child');
    expect(row.textContent).toContain('待重试');
    expect(row.querySelector('.retry-button')).not.toBeNull();
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    expect(component['draft']()).toBe('');
    component.ionViewDidLeave();
    expect(TestBed.inject(DraftStore).get(testChat.id)).toBeUndefined();
    expect(TestBed.inject(MessageOutbox).items()).toEqual([item]);
    await reenter();
    expect(component['draft']()).toBe('');
    expect(component['rows']().at(-1)?.outgoing).toBe(item);
    expect(fixture.nativeElement.querySelector('app-message:last-child .retry-button')).not.toBeNull();
    fixture.nativeElement.querySelector('app-message:last-child .retry-button').click();
    const retrying = item.operation;
    fixture.detectChanges();
    expect(item.delivery()).toBe(MessageDelivery.Sending);
    expect(fixture.nativeElement.querySelector('app-message:last-child .retry-button')).toBeNull();
    http.expectOne(`/_api/chats/${wireChat.id}/messages`).flush('', { status: 503, statusText: 'Unavailable' });
    await retrying;
    await fixture.whenStable();
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    expect(fixture.nativeElement.querySelector('app-message:last-child .retry-button ion-icon')).not.toBeNull();
  });

  it.each(['http', 'websocket'])(
    'retries the failed row with the same UUID and renders one confirmation when %s arrives first',
    async (firstAcknowledgement) => {
      component['draft'].set('  新消息  ');
      const sending = component['sendMessage']();
      const item = component['outbox'].items()[0];
      const first = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
      expect(first.request.method).toBe('POST');
      expect(first.request.body.message).toBe('新消息');
      const body = structuredClone(first.request.body);
      expect(body.clientGeneratedId).toBe(item.clientGeneratedId);
      expect(component['draft']()).toBe('');
      fixture.detectChanges();
      const local = fixture.debugElement.queryAll(By.directive(Message)).at(-1)!;
      const message = local.componentInstance as Message<MessageContent>;
      expect(message.message().id).toBeUndefined();
      expect(message.delivery()).toBe(MessageDelivery.Sending);
      expect(local.nativeElement.textContent).toContain('新消息');
      first.flush('', { status: 503, statusText: 'Unavailable' });
      await sending;
      fixture.detectChanges();
      expect(component['draft']()).toBe('');
      expect(message.delivery()).toBe(MessageDelivery.Failed);
      expect(local.nativeElement.querySelector('.retry-button')).not.toBeNull();

      component['updateDraft']('确认期间继续写');
      component['startReply'](testMessage);
      const retrying = component['outbox'].retry(item);
      expect(component['outbox'].retry(item)).toBe(retrying);
      const retry = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
      expect(retry.request.body).toEqual(body);
      const response = {
        ...wireMessage,
        id: '9007199254741005',
        clientGeneratedId: retry.request.body.clientGeneratedId,
        message: '新消息',
      };
      const echoed = { ...response, id: encodeId(response.id), chatId: testChat.id };
      if (firstAcknowledgement === 'websocket') {
        incoming.next(echoed);
        fixture.detectChanges();
        expect(fixture.debugElement.queryAll(By.directive(Message))).toHaveLength(2);
      }
      if (firstAcknowledgement === 'websocket') expect(retry.cancelled).toBe(true);
      else retry.flush(structuredClone(response));
      await retrying;
      if (firstAcknowledgement === 'http') incoming.next(echoed);
      await fixture.whenStable();
      expect(component['conversation'].items()).toHaveLength(2);
      expect(component['rows']().filter((row) => row.key === item.clientGeneratedId)).toHaveLength(1);
      expect(component['outbox'].items()).toEqual([]);
      const confirmed = fixture.debugElement.queryAll(By.directive(Message));
      expect(confirmed).toHaveLength(2);
      expect(confirmed.at(-1)!.nativeElement).toBe(local.nativeElement);
      expect(message.message().id).toBe(encodeId(response.id));
      expect(message.interactive()).toBe(true);
      expect(local.nativeElement.querySelector('.retry-button')).toBeNull();
      expect(component['draft']()).toBe('确认期间继续写');
      expect(component['replyTo']()).toBe(testMessage);
      expect(component['composer']()!.text()).toBe('确认期间继续写');
    },
  );

  it('appends local rows in submission order after confirmed messages regardless of createdAt', async () => {
    const timestamp = vi.spyOn(Date.prototype, 'toISOString');
    timestamp.mockReturnValueOnce('2000-01-02T00:00:00Z');
    component['updateDraft']('第一条本地消息');
    const firstSending = component['sendMessage']();
    const firstRequest = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    timestamp.mockReturnValueOnce('2000-01-01T00:00:00Z');
    component['updateDraft']('第二条本地消息');
    void component['sendMessage']();
    const [first, second] = component['outbox'].items();
    expect(first.clientGeneratedId).not.toBe(second.clientGeneratedId);
    expect(first.message().createdAt).toBe('2000-01-02T00:00:00Z');
    expect(second.message().createdAt).toBe('2000-01-01T00:00:00Z');
    http.expectNone((req) => req.method === 'POST');
    incoming.next({
      ...testMessage,
      id: encodeId('9007199254741005'),
      clientGeneratedId: 'live-between-submissions-and-confirmation',
      message: '已确认的新消息',
    });
    fixture.detectChanges();
    const rendered = fixture.debugElement.queryAll(By.directive(Message));
    expect(rendered.map((row) => (row.componentInstance as Message<MessageContent>).message().message)).toEqual([
      '测试消息',
      '已确认的新消息',
      '第一条本地消息',
      '第二条本地消息',
    ]);
    expect(
      component['rows']()
        .slice(-2)
        .map((row) => row.outgoing),
    ).toEqual([first, second]);
    expect(component['draft']()).toBe('');
    firstRequest.flush({
      ...wireMessage,
      id: '9007199254741007',
      clientGeneratedId: firstRequest.request.body.clientGeneratedId,
      message: '第一条本地消息',
    });
    await firstSending;
    const secondRequest = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    secondRequest.flush('', { status: 503, statusText: 'Unavailable' });
    await vi.waitFor(() => expect(second.delivery()).toBe(MessageDelivery.Failed));
    await fixture.whenStable();
    const rows = fixture.debugElement.queryAll(By.directive(Message));
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)!.nativeElement).toBe(rendered.at(-1)!.nativeElement);
    expect(component['rows']().at(-1)?.outgoing).toBe(second);
    expect(second.delivery()).toBe(MessageDelivery.Failed);
  });

  it('sends later text while an attachment uploads and displays confirmations in server order', async () => {
    const media = pendingUpload();
    component['updateDraft']('附件消息');
    void component['sendMessage']({ messageType: MessageType.text, attachmentIds: [], uploads: [media.upload] });
    const attachmentItem = component['outbox'].items()[0];
    typeText('先发的文字');
    (fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement).click();
    const firstText = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    expect(firstText.request.body.message).toBe('先发的文字');
    expect(firstText.request.body.attachmentIds).toEqual([]);
    typeText('后发的文字');
    (fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement).click();
    const [, firstTextItem, secondTextItem] = component['outbox'].items();
    fixture.detectChanges();
    expect(component['rows']()).toHaveLength(4);
    expect(attachmentItem.delivery()).toBe(MessageDelivery.Sending);
    expect(media.upload.state().status).toBe(UploadStatus.Uploading);
    http.expectNone((request) => request.method === 'POST');
    typeText('继续保留的草稿');
    firstText.flush({
      ...wireMessage,
      id: '9007199254741005',
      clientGeneratedId: firstTextItem.clientGeneratedId,
      message: '先发的文字',
    });
    const secondText = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    expect(secondText.request.body.message).toBe('后发的文字');
    expect(secondText.request.body.clientGeneratedId).toBe(secondTextItem.clientGeneratedId);
    secondText.flush({
      ...wireMessage,
      id: '9007199254741007',
      clientGeneratedId: secondTextItem.clientGeneratedId,
      message: '后发的文字',
    });
    await vi.waitFor(() => expect(secondTextItem.delivery()).toBe(MessageDelivery.Sent));
    await fixture.whenStable();
    expect(media.upload.state().status).toBe(UploadStatus.Uploading);
    expect(component['outbox'].items()).toEqual([attachmentItem]);
    expect(component['rows']().map((row) => row.message.message)).toEqual([
      '测试消息',
      '先发的文字',
      '后发的文字',
      '附件消息',
    ]);
    media.finish(encodeId('100'));
    const attachment = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    expect(attachment.request.body.message).toBe('附件消息');
    expect(attachment.request.body.attachmentIds).toEqual(['100']);
    attachment.flush({
      ...wireMessage,
      id: '9007199254741009',
      clientGeneratedId: attachmentItem.clientGeneratedId,
      message: '附件消息',
      hasAttachments: true,
      attachments: [{ id: '100', url: media.upload.url, fileName: 'edit.png', kind: 'image/png', size: 5 }],
    });
    await vi.waitFor(() => expect(attachmentItem.delivery()).toBe(MessageDelivery.Sent));
    await fixture.whenStable();
    expect(component['rows']().map((row) => row.message.id)).toEqual([
      testMessage.id,
      encodeId('9007199254741005'),
      encodeId('9007199254741007'),
      encodeId('9007199254741009'),
    ]);
    expect(fixture.debugElement.queryAll(By.directive(Message))).toHaveLength(4);
    expect(component['rows']().filter((row) => row.key === attachmentItem.clientGeneratedId)).toHaveLength(1);
    expect(component['outbox'].items()).toEqual([]);
    expect(component['draft']()).toBe('继续保留的草稿');
    expect(component['composer']()!.text()).toBe('继续保留的草稿');
  });

  it('retains live messages while older pages load and deduplicates echoed messages', async () => {
    const loading = component['loadPage'](PageDirection.Older);
    await Promise.resolve();
    const olderRequest = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`);
    const live = { ...testMessage, id: encodeId('9007199254741007'), message: '实时消息' };
    component['atBottom'].set(false);
    component['position'].set(undefined);
    incoming.next(live);
    incoming.next(live);
    olderRequest.flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage, id: '9007199254741001' }],
      olderCursor: null,
    });
    await loading;
    expect(component['conversation'].items().map((message) => message.id)).toEqual([
      encodeId('9007199254741001'),
      testMessage.id,
      live.id,
    ]);
    expect(component['position']()).toBeUndefined();
    Object.defineProperty(scroll, 'scrollHeight', { value: 800, configurable: true });
    scroll.scrollTop = 120;
    component['atBottom'].set(true);
    incoming.next({ ...live, id: encodeId('9007199254741009') });
    await fixture.whenStable();
    await component['positionAndRead']();
    expect(scroll.scrollTop).toBe(800);
  });

  it('hides every membership action from history and live messages, reloading visibility without replacing known message nodes', async () => {
    const actions = [
      [SystemMessageKind.member_joined, 'joined the chat'],
      [SystemMessageKind.member_left, 'left the chat'],
      [SystemMessageKind.member_added, 'added 小花'],
      [SystemMessageKind.member_removed, 'removed 小花'],
    ] as const;
    const loading = component['conversation'].load(PageDirection.Older);
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: actions.map(([systemKind, message], index) => ({
        ...wireMessage,
        id: String(100 + index),
        clientGeneratedId: `membership-${index}`,
        messageType: MessageType.system,
        systemKind,
        message,
        createdAt: '2026-09-04T12:00:00Z',
      })),
    });
    await loading;
    await fixture.whenStable();
    expect(component['rows']()).toHaveLength(5);
    const originalHistory = component['conversation'].items();
    const original = fixture.nativeElement.querySelector(`[data-message-id="${wireMessage.id}"]`);
    membershipMessages.set(false);
    await fixture.whenStable();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50`)
      .flush({ chatSettings: { showMembershipMessages: true }, messages: [{ ...wireMessage }] });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('app-message')).toHaveLength(1);
    expect(fixture.nativeElement.querySelectorAll('.message-date')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector(`[data-message-id="${wireMessage.id}"]`)).toBe(original);
    const hiddenLive = actions.map(([systemKind, message], index) => ({
      ...testMessage,
      id: encodeId(String(9007199254741010n + BigInt(index))),
      clientGeneratedId: `live-membership-${index}`,
      messageType: MessageType.system,
      systemKind,
      message,
      systemLinks: { uid: 42 },
    }));
    hiddenLive.forEach((message) => incoming.next(message));
    incoming.next({
      ...testMessage,
      id: encodeId('9007199254741020'),
      clientGeneratedId: 'normal',
      message: 'joined the chat',
    });
    await fixture.whenStable();
    expect(component['rows']()).toHaveLength(2);
    expect(component['rows']().map(({ first, last, dateBreak }) => ({ first, last, dateBreak }))).toEqual([
      { first: true, last: false, dateBreak: true },
      { first: false, last: true, dateBreak: false },
    ]);
    const retained = [
      'pinned a message',
      'unpinned a message',
      'pinned a message in this thread',
      'unpinned a message in this thread',
      "accepted 小花's friend request",
      'unknown action',
    ];
    retained.forEach((message, index) =>
      incoming.next({
        ...testMessage,
        id: encodeId(String(9007199254741030n + BigInt(index))),
        clientGeneratedId: `retained-${index}`,
        messageType: MessageType.system,
        message,
      }),
    );
    await fixture.whenStable();
    expect(component['rows']()).toHaveLength(8);
    const history = [...originalHistory.slice(0, -1), ...hiddenLive, ...component['conversation'].items()].map(
      (message) => ({
        ...wireMessage,
        ...message,
        id: decodeId(message.id),
        chatId: wireChat.id,
      }),
    );
    membershipMessages.set(true);
    await fixture.whenStable();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50`)
      .flush({ chatSettings: { showMembershipMessages: true }, messages: history });
    await fixture.whenStable();
    expect(component['rows']()).toHaveLength(16);
    http.expectNone(() => true);
    membershipMessages.set(false);
    TestBed.inject(ChatStore).remember([{ ...testChat, kind: GroupKind.dm }]);
    await fixture.whenStable();
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`).flush({});
    expect(component['rows']()).toHaveLength(16);
    http.expectNone(() => true);
  });

  it('rebuilds the visible range when a continuation discovers settings from another device', async () => {
    const session = TestBed.inject(SessionStore);
    vi.spyOn(TestBed.inject(Preferences), 'showMembershipMessages').mockImplementation(
      () => session.user()?.showMembershipMessages ?? true,
    );
    membershipMessages.set(false);
    await fixture.whenStable();
    const previous = component['conversation'].items();
    const loading = component['conversation'].load(PageDirection.Older);
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`).flush({
      chatSettings: { showMembershipMessages: false },
      messages: [{ ...wireMessage, id: '50' }],
    });
    await loading;
    await fixture.whenStable();
    expect(component['conversation'].items()).toEqual(previous);
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`);
    request.flush({ chatSettings: { showMembershipMessages: false }, messages: [{ ...wireMessage }] });
    await fixture.whenStable();
    expect(component['conversation'].hideMembershipMessages).toBe(true);
    expect(component['conversation'].items()).toEqual(previous);
  });

  it('confirms only the visible message after its bubble is fully visible', async () => {
    membershipMessages.set(false);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    Object.defineProperties(scroll, {
      clientHeight: { value: 200, configurable: true },
      scrollHeight: { value: 220, configurable: true },
    });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    const opening = component['conversation'].open(undefined, false, true);
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage, id: '100' }],
    });
    await opening;
    await fixture.whenStable();
    const element = fixture.nativeElement.querySelector('app-message') as HTMLElement;
    const rect = vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 220));
    component.ionViewDidEnter();
    await component['positionAndRead']();
    const markRead = vi.mocked(TestBed.inject(ChatStore).markRead);
    markRead.mockClear();
    await component['trackScroll']();
    expect(markRead).not.toHaveBeenCalled();
    rect.mockReturnValue(new DOMRect(0, -20, 300, 220));
    scroll.scrollTop = 20;
    const covered = vi.spyOn(component['panels'], 'covered').mockReturnValue(true);
    await component['trackScroll']();
    expect(markRead).not.toHaveBeenCalled();
    covered.mockReturnValue(false);
    await component['trackScroll']();
    expect(markRead).toHaveBeenLastCalledWith(testChat.id, encodeId('100'));
  });

  it('shows a confirmed filtered empty state without advancing a read cursor', async () => {
    membershipMessages.set(false);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const opening = component['conversation'].open(undefined, false, true);
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50`)
      .flush({ chatSettings: { showMembershipMessages: true }, messages: [] });
    await opening;
    await fixture.whenStable();
    component.ionViewDidEnter();
    await component['positionAndRead']();
    expect(fixture.nativeElement.textContent).toContain('暂无可显示的消息');
    expect(fixture.nativeElement.querySelector('.pagination-control')).toBeNull();
    expect(TestBed.inject(ChatStore).markRead).not.toHaveBeenCalled();
    http.expectNone(() => true);
  });

  it('does not send read confirmations for hidden targets or hidden live events', async () => {
    membershipMessages.set(false);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    Object.defineProperty(scroll, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { value: 800, configurable: true });
    const loading = component['conversation'].open(encodeId('101'), false, true);
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=101`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        {
          ...wireMessage,
          id: '101',
          messageType: MessageType.system,
          systemKind: SystemMessageKind.member_joined,
          message: 'joined the chat',
        },
      ],
    });
    await loading;
    await fixture.whenStable();
    component.ionViewDidEnter();
    component['position'].set(undefined);
    const markRead = vi.mocked(TestBed.inject(ChatStore).markRead);
    markRead.mockClear();
    scroll.scrollTop = 0;
    await component['trackScroll']();
    expect(markRead).not.toHaveBeenCalled();
    scroll.scrollTop = 600;
    await component['trackScroll']();
    expect(component['rows']()).toEqual([]);
    expect(markRead).not.toHaveBeenCalled();
    incoming.next({
      ...testMessage,
      id: encodeId('102'),
      messageType: MessageType.system,
      systemKind: SystemMessageKind.member_left,
      message: 'left the chat',
    });
    await fixture.whenStable();
    expect(markRead).not.toHaveBeenCalled();
    markRead.mockClear();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await component['trackScroll']();
    expect(markRead).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'does not skip an unread visible message before a hidden tail (deleted tail: %s)',
    async (deletedTail) => {
      membershipMessages.set(false);
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
      Object.defineProperties(scroll, {
        clientHeight: { value: 200, configurable: true },
        scrollHeight: { value: 220, configurable: true },
      });
      vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
      const loading = component['conversation'].open(encodeId('100'), false, true);
      http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=100`).flush({
        chatSettings: { showMembershipMessages: true },
        messages: [
          { ...wireMessage, id: '100', clientGeneratedId: 'visible' },
          {
            ...wireMessage,
            id: '101',
            clientGeneratedId: 'hidden',
            messageType: MessageType.system,
            systemKind: SystemMessageKind.member_left,
            message: 'left the chat',
          },
          ...(deletedTail
            ? [{ ...wireMessage, id: '102', clientGeneratedId: 'deleted', isDeleted: true, message: null }]
            : []),
        ],
      });
      await loading;
      await fixture.whenStable();
      const element = fixture.nativeElement.querySelector('app-message') as HTMLElement;
      const rect = vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 220));
      component.ionViewDidEnter();
      await component['positionAndRead']();
      const markRead = vi.mocked(TestBed.inject(ChatStore).markRead);
      markRead.mockClear();
      scroll.scrollTop = 0;
      await component['trackScroll']();
      expect(markRead).not.toHaveBeenCalled();
      rect.mockReturnValue(new DOMRect(0, -20, 300, 220));
      scroll.scrollTop = 20;
      await component['trackScroll']();
      expect(markRead).toHaveBeenLastCalledWith(testChat.id, encodeId('100'));
    },
  );

  it.each([false, true])(
    'locates a visible neighbour of a hidden membership link (following neighbour: %s)',
    async (following) => {
      membershipMessages.set(false);
      const navigating = component['goTo']({ type: ConversationTargetKind.Message, messageId: encodeId('101') });
      http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=101`).flush({
        chatSettings: { showMembershipMessages: true },
        messages: [
          { ...wireMessage, id: '100', clientGeneratedId: 'before' },
          {
            ...wireMessage,
            id: '101',
            clientGeneratedId: 'hidden',
            messageType: MessageType.system,
            systemKind: SystemMessageKind.member_joined,
            message: 'joined the chat',
          },
          ...(following ? [{ ...wireMessage, id: '102', clientGeneratedId: 'after' }] : []),
        ],
      });
      await navigating;
      expect(component['position']()).toMatchObject({ messageId: encodeId(following ? '102' : '100') });
      expect(component['rows']().some(({ message }) => message.id === encodeId('101'))).toBe(false);
    },
  );

  it.each([
    { neighbours: ['100', '103'], anchor: '103', retry: false },
    { neighbours: ['100'], anchor: '100', retry: false },
    { neighbours: [], anchor: undefined, retry: false },
    { neighbours: ['100', '103'], anchor: '103', retry: true },
  ])(
    'retains an all-membership historical location when hiding events ($anchor, retry: $retry)',
    async ({ neighbours, anchor, retry }) => {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
      Object.defineProperties(scroll, {
        clientHeight: { value: 200, configurable: true },
        scrollHeight: { value: 1000, configurable: true },
      });
      vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
      const history = ['101', '102'].map((id) => ({
        ...wireMessage,
        id,
        clientGeneratedId: `membership-${id}`,
        messageType: MessageType.system,
        systemKind: SystemMessageKind.member_joined,
        message: 'joined the chat',
      }));
      const loading = component['conversation'].open(encodeId('101'));
      http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=101`).flush({
        chatSettings: { showMembershipMessages: true },
        messages: history,
        olderCursor: '101',
        newerCursor: '102',
      });
      await loading;
      await fixture.whenStable();
      const elements = [...fixture.nativeElement.querySelectorAll('app-message')] as HTMLElement[];
      elements.forEach((element, index) =>
        vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, index * 50, 300, 50)),
      );
      component.ionViewDidEnter();
      await component['positionAndRead']();
      scroll.scrollTop = 500;
      await component['trackScroll']();
      component['leave'](true);
      membershipMessages.set(false);
      await fixture.whenStable();
      const reopening = vi.spyOn(component['conversation'], 'open');
      component['active'].set(true);
      await fixture.whenStable();
      let request = http.expectOne((request) => request.url.endsWith('/messages'));
      const around = request.request.params.get('around');
      if (retry) {
        request.flush('offline', { status: 503, statusText: 'Unavailable' });
        await fixture.whenStable();
        component.ionViewDidEnter();
        await component['positionAndRead']();
        component['retryAction']();
        request = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=101`);
      }
      const position = vi.spyOn(component['position'], 'set');
      request.flush({
        chatSettings: { showMembershipMessages: true },
        messages: [
          history[0],
          ...neighbours.map((id) => ({ ...wireMessage, id, clientGeneratedId: `visible-${id}` })),
        ].sort((a, b) => Number(a.id) - Number(b.id)),
      });
      await reopening.mock.results.at(-1)!.value;
      await fixture.whenStable();
      expect(around).toBe('101');
      expect(component['rows']().map((row) => decodeId(row.message.id!))).toEqual(neighbours);
      if (anchor) {
        expect(position).toHaveBeenCalledWith(expect.objectContaining({ messageId: encodeId(anchor), offset: 50 }));
      } else {
        expect(scroll.scrollTop).toBe(scroll.scrollHeight);
      }
      http.expectNone(() => true);
    },
  );

  it('preserves the reading anchor when membership visibility changes under settings', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    Object.defineProperties(scroll, {
      clientHeight: { value: 200, configurable: true },
      scrollHeight: { value: 1000, configurable: true },
    });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    const loading = component['conversation'].open(encodeId('100'));
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=100`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        { ...wireMessage, id: '100', clientGeneratedId: 'before' },
        {
          ...wireMessage,
          id: '101',
          clientGeneratedId: 'hidden',
          messageType: MessageType.system,
          systemKind: SystemMessageKind.member_joined,
          message: 'joined the chat',
        },
        { ...wireMessage, id: '102', clientGeneratedId: 'anchor' },
      ],
    });
    await loading;
    await fixture.whenStable();
    const history = component['conversation']
      .items()
      .map((message) => ({ ...wireMessage, ...message, id: decodeId(message.id), chatId: wireChat.id }));
    const elements = [...fixture.nativeElement.querySelectorAll('app-message')] as HTMLElement[];
    vi.spyOn(elements[0], 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 300 - scroll.scrollTop, 300, 100),
    );
    vi.spyOn(elements[1], 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 400 - scroll.scrollTop, 300, 40),
    );
    vi.spyOn(elements[2], 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, (membershipMessages() ? 480 : 440) - scroll.scrollTop, 300, 100),
    );
    component.ionViewDidEnter();
    await component['positionAndRead']();
    scroll.scrollTop = 500;
    await component['trackScroll']();
    component['leave'](true);
    membershipMessages.set(false);
    await fixture.whenStable();
    component['active'].set(true);
    await fixture.whenStable();
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=102`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: history.filter((message) => message.id !== '101').map((message) => ({ ...message })),
    });
    await fixture.whenStable();
    component.ionViewDidEnter();
    await component['positionAndRead']();
    expect(scroll.scrollTop).toBe(460);
    expect(fixture.nativeElement.querySelector('[data-message-id="102"]')).toBe(elements[2]);
    component['leave'](true);
    membershipMessages.set(true);
    await fixture.whenStable();
    component['active'].set(true);
    await fixture.whenStable();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=102`)
      .flush({ chatSettings: { showMembershipMessages: true }, messages: history });
    await fixture.whenStable();
    component.ionViewDidEnter();
    await component['positionAndRead']();
    expect(scroll.scrollTop).toBe(500);
  });

  it('hides membership messages before delayed group metadata arrives on direct entry', async () => {
    membershipMessages.set(false);
    const chatId = '9007199254740995';
    fixture.componentRef.setInput('id', chatId);
    fixture.detectChanges();
    const metadata = http.expectOne(`/_api/group/${chatId}`);
    await Promise.resolve();
    http.expectOne(`/_api/chats/${chatId}/messages?max=50`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        {
          ...wireMessage,
          chatId,
          messageType: MessageType.system,
          systemKind: SystemMessageKind.member_joined,
          message: 'joined the chat',
        },
      ],
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('app-message')).toHaveLength(0);
    metadata.flush({ ...wireChat, id: chatId });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('app-message')).toHaveLength(0);
  });

  it('keeps both pagination cursors when an entire page consists of hidden membership messages', async () => {
    membershipMessages.set(false);
    const opening = component['conversation'].open(encodeId('101'), false, true);
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=101`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        {
          ...wireMessage,
          id: '101',
          messageType: MessageType.system,
          systemKind: SystemMessageKind.member_joined,
          message: 'joined the chat',
        },
      ],
      olderCursor: '101',
      newerCursor: '101',
    });
    await opening;
    await fixture.whenStable();
    expect(component['rows']()).toEqual([]);
    expect(fixture.nativeElement.querySelectorAll('.pagination-control')).toHaveLength(2);
    expect(fixture.nativeElement.textContent).not.toContain('暂无可显示的消息');
    const hiddenPage = component['loadPage'](PageDirection.Newer);
    await Promise.resolve();
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&after=101`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        {
          ...wireMessage,
          id: '102',
          messageType: MessageType.system,
          systemKind: SystemMessageKind.member_left,
          message: 'left the chat',
        },
      ],
      newerCursor: '102',
    });
    await hiddenPage;
    await fixture.whenStable();
    expect(component['rows']()).toEqual([]);
    expect(component['conversation'].page()?.olderCursor).toBe(encodeId('101'));
    expect(component['conversation'].page()?.newerCursor).toBe(encodeId('102'));
    const visiblePage = component['loadPage'](PageDirection.Newer);
    await Promise.resolve();
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&after=102`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage, id: '103', clientGeneratedId: 'visible' }],
    });
    await visiblePage;
    await fixture.whenStable();
    expect(component['rows']().map(({ message }) => message.id)).toEqual([encodeId('103')]);
    expect(component['conversation'].items()).toHaveLength(3);
    expect(component['conversation'].atLatest()).toBe(true);
  });

  it('renders grouping flags from the loaded and live message range', async () => {
    incoming.next({ ...testMessage, id: encodeId('9007199254741005') });
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelectorAll('.sender')).toHaveLength(1);
    expect(element.querySelectorAll('app-message ion-avatar')).toHaveLength(1);
    expect(element.querySelectorAll('.message-date')).toHaveLength(1);
    expect(element.querySelector(`[data-message-id="${wireMessage.id}"] .chat-row.last`)).toBeNull();
    expect(element.querySelector('[data-message-id="9007199254741005"] .sender')).toBeNull();
    expect(element.querySelector('[data-message-id="9007199254741005"] .chat-row.last')).not.toBeNull();
  });

  it('moves the selected reply into the failed row and retries it without changing the next reply draft', async () => {
    vi.spyOn(IonTextarea.prototype, 'setFocus').mockResolvedValue();
    component['startReply'](testMessage);
    component['draft'].set('回复内容');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.reply-context').textContent).toContain('测试用户');
    const sending = component['sendMessage']();
    const item = component['outbox'].items()[0];
    const first = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    expect(first.request.body.replyToId).toBe(wireMessage.id);
    expect(component['draft']()).toBe('');
    expect(component['replyTo']()).toBeUndefined();
    expect(component['savedReplyId']()).toBeUndefined();
    expect(item.message().replyToMessage).toMatchObject(testMessage);
    first.flush('', { status: 503, statusText: 'Unavailable' });
    await sending;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.reply-context')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-message:last-child .reply-preview').textContent).toContain(
      '测试消息',
    );
    const nextReply = { ...testMessage, id: encodeId('9007199254741009'), clientGeneratedId: 'next-reply' };
    component['updateDraft']('下一条回复');
    component['startReply'](nextReply);
    const retrying = component['outbox'].retry(item);
    const retry = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    expect(retry.request.body).toEqual(first.request.body);
    retry.flush({
      ...wireMessage,
      id: '9007199254741005',
      clientGeneratedId: retry.request.body.clientGeneratedId,
      message: '回复内容',
      replyToMessage: structuredClone(wireMessage),
    });
    await retrying;
    await fixture.whenStable();
    expect(component['draft']()).toBe('下一条回复');
    expect(component['replyTo']()).toBe(nextReply);
    const nextSending = component['sendMessage']();
    const next = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    expect(next.request.body.clientGeneratedId).not.toBe(item.clientGeneratedId);
    expect(next.request.body.replyToId).toBe(decodeId(nextReply.id));
    next.flush('', { status: 503, statusText: 'Unavailable' });
    await nextSending;
    expect(component['replyTo']()).toBeUndefined();
    expect(component['outbox'].items().at(-1)?.message().replyToMessage).toMatchObject(nextReply);
  });

  it('resumes around the frozen read boundary and a second chat click requests the latest directly', async () => {
    const data = TestBed.inject(ChatStore);
    const read = vi.mocked(data.cachedReadState);
    component.ionViewDidLeave();
    read.mockReturnValue({
      lastReadMessageId: encodeId('100'),
      unreadCount: 90,
      unreadMentions: 0,
      unreadReactions: 0,
    });
    component.ionViewWillEnter();
    if (component.threadId())
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(component.threadId()!)}`))
        req.flush({ ...wireMessage, id: decodeId(component.threadId()!) });
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=100`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        { ...wireMessage, id: '100' },
        { ...wireMessage, id: '101', sender: otherSender },
      ],
      olderCursor: '100',
      newerCursor: '101',
    });
    await fixture.whenStable();
    expect(component['firstUnreadId']()).toBe(encodeId('101'));
    read.mockReturnValue({
      lastReadMessageId: encodeId('101'),
      unreadCount: 89,
      unreadMentions: 0,
      unreadReactions: 0,
    });
    await fixture.whenStable();
    expect(component['entryReadId']()).toBe(encodeId('100'));
    expect(fixture.nativeElement.querySelector('.unread-separator')).not.toBeNull();
    TestBed.inject(ConversationNavigation).goTo(testChat.id, { type: ConversationTargetKind.Latest });
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage }],
      olderCursor: wireMessage.id,
    });
    await fixture.whenStable();
    expect(component['conversation'].items()).toEqual([testMessage]);
  });

  it.each([
    { height: 1600, expectedTop: 1000 },
    { height: 1200, expectedTop: 700 },
  ])('positions the unread divider within the scroll range ($height px)', async ({ height, expectedTop }) => {
    component.ionViewDidLeave();
    vi.mocked(TestBed.inject(ChatStore).cachedReadState).mockReturnValue({
      lastReadMessageId: encodeId('100'),
      unreadCount: 1,
      unreadMentions: 0,
      unreadReactions: 0,
    });
    component.ionViewWillEnter();
    if (component.threadId())
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(component.threadId()!)}`))
        req.flush({ ...wireMessage, id: decodeId(component.threadId()!) });
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=100`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        { ...wireMessage, id: '100' },
        { ...wireMessage, id: '101', sender: otherSender },
      ],
    });
    Object.defineProperties(scroll, {
      clientHeight: { value: 500 },
      scrollHeight: { value: height },
    });
    scroll.scrollTop = 0;
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 50, 300, 500));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('unread-separator') ? new DOMRect(0, 1050, 300, 20) : new DOMRect();
    });
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(expectedTop);
    expect(fixture.nativeElement.querySelector('.unread-separator').textContent).toContain('未读消息');
    vi.mocked(TestBed.inject(ChatStore).cachedReadState).mockReturnValue({
      lastReadMessageId: encodeId('101'),
      unreadCount: 0,
      unreadMentions: 0,
      unreadReactions: 0,
    });
    await fixture.whenStable();
    expect(component['firstUnreadId']()).toBe(encodeId('101'));
    expect(scroll.scrollTop).toBe(expectedTop);
  });

  it('keeps the latest messages at the bottom when pins or the composer reduce the viewport', async () => {
    let height = 500;
    let top = 500;
    Object.defineProperties(scroll, {
      clientHeight: { get: () => height },
      scrollHeight: { value: 1000 },
      scrollTop: {
        get: () => top,
        set: (value: number) => {
          top = Math.min(value, 1000 - height);
        },
      },
    });
    await component['trackScroll']();
    expect(component['atBottom']()).toBe(true);
    height = 448;
    resizes.get(scroll)!();
    await fixture.whenStable();
    expect(top).toBe(552);
    expect(component['atBottom']()).toBe(true);
    expect(component['showDownButton']()).toBe(false);
  });

  it('preserves the reading position during size changes when the user has scrolled up', async () => {
    let height = 500;
    Object.defineProperties(scroll, {
      clientHeight: { get: () => height },
      scrollHeight: { value: 1000 },
    });
    scroll.scrollTop = 200;
    await component['trackScroll']();
    height = 448;
    resizes.get(scroll)!();
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(200);
    expect(component['showDownButton']()).toBe(true);
  });

  it('keeps messages at their screen positions when the first pin appears or disappears while reading history', async () => {
    Object.defineProperties(scroll, { clientHeight: { value: 448 }, scrollHeight: { value: 1000 } });
    scroll.scrollTop = 200;
    await component['trackScroll']();
    const rect = vi.spyOn(scroll, 'getBoundingClientRect');
    rect.mockReturnValue(new DOMRect(0, 52, 300, 448));
    resizes.get(scroll)!();
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(252);
    rect.mockReturnValue(new DOMRect(0, 0, 300, 500));
    resizes.get(scroll)!();
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(200);
  });

  it('ignores app-shell panning when resizing the viewport while reading history', async () => {
    Object.defineProperties(scroll, { clientHeight: { value: 448 }, scrollHeight: { value: 1000 } });
    scroll.scrollTop = 200;
    await component['trackScroll']();
    const bodyRect = vi.spyOn(document.body, 'getBoundingClientRect');
    const scrollRect = vi.spyOn(scroll, 'getBoundingClientRect');
    bodyRect.mockReturnValue(new DOMRect(0, 80, 300, 500));
    scrollRect.mockReturnValue(new DOMRect(0, 80, 300, 448));
    resizes.get(scroll)!();
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(200);
    // A pin appearing within the resized app still needs normal compensation.
    scrollRect.mockReturnValue(new DOMRect(0, 132, 300, 396));
    resizes.get(scroll)!();
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(252);
    bodyRect.mockRestore();
    scrollRect.mockRestore();
  });

  it('does not reuse the previous visit viewport offset when entering again', async () => {
    const rect = vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 52, 300, 448));
    resizes.get(scroll)!();
    await fixture.whenStable();
    component.ionViewDidLeave();
    await reenter();
    Object.defineProperties(scroll, { clientHeight: { value: 500 }, scrollHeight: { value: 1000 } });
    scroll.scrollTop = 200;
    await component['trackScroll']();
    rect.mockReturnValue(new DOMRect(0, 0, 300, 500));
    resizes.get(scroll)!();
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(200);
  });

  it('does not pin a historical range to the bottom on resize and releases observation on destroy', async () => {
    const opening = component['conversation'].open(encodeId('100'));
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=100`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage }],
      newerCursor: wireMessage.id,
    });
    await opening;
    await fixture.whenStable();
    scroll.scrollTop = 200;
    component['atBottom'].set(true);
    resizes.get(scroll)!();
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(200);
    fixture.destroy();
    expect(resizes.has(scroll)).toBe(false);
  });

  function useReactionHttp() {
    const api = TestBed.inject(ChatsService);
    if (vi.isMockFunction(api.getChatReactions)) vi.mocked(api.getChatReactions).mockRestore();
    if (vi.isMockFunction(api.acknowledgeChatReactions)) vi.mocked(api.acknowledgeChatReactions).mockRestore();
  }
  function useMentionHttp() {
    vi.mocked(TestBed.inject(ChatsService).getChatMentions).mockRestore();
  }
  async function notificationSettled() {
    await new Promise((resolve) => setTimeout(resolve, 110));
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
  const reactionBoundary = '2026-10-20T00:00:00Z';
  function reactionNotification(id = testMessage.id) {
    events.next({
      type: ServerWsMessageType.notification,
      payload: {
        notificationType: NotificationType.reaction,
        chatId: testChat.id,
        messageId: id,
        threadRootId: undefined,
        actorUid: 2,
      },
    });
  }

  it('does not acknowledge reactions received behind a panel when navigating to another conversation', async () => {
    const router = TestBed.inject(Router);
    const url = vi.spyOn(router, 'url', 'get');
    const cover = (covered: boolean) => {
      const path = `/chats/chat/${wireChat.id}` + (covered ? '?profile=2' : '');
      url.mockReturnValue(path);
      (router.events as Subject<NavigationEnd>).next(new NavigationEnd(1, path, path));
      fixture.detectChanges();
    };
    component.ionViewDidEnter();
    await fixture.whenStable();
    const api = TestBed.inject(ChatsService);
    vi.mocked(api.acknowledgeChatReactions).mockClear();
    cover(true);
    fixture.detectChanges();
    reactionNotification();
    await fixture.whenStable();
    // The destination URL no longer contains the source panel when Ionic leaves the old page.
    vi.mocked(TestBed.inject(Router).isActive).mockReturnValue(false);
    cover(false);
    fixture.detectChanges();
    component.ionViewWillLeave();
    await fixture.whenStable();
    expect(api.acknowledgeChatReactions).not.toHaveBeenCalled();
  });

  it('ignores a snapshot covered in flight and refreshes reactions when the panel closes', async () => {
    const router = TestBed.inject(Router);
    const url = vi.spyOn(router, 'url', 'get');
    const cover = (covered: boolean) => {
      const path = `/chats/chat/${wireChat.id}` + (covered ? '?profile=2' : '');
      url.mockReturnValue(path);
      (router.events as Subject<NavigationEnd>).next(new NavigationEnd(1, path, path));
      fixture.detectChanges();
    };
    useReactionHttp();
    component.ionViewDidEnter();
    const pending = http.expectOne(`/_api/chats/${wireChat.id}/reactions`);
    cover(true);
    fixture.detectChanges();
    pending.flush({ messageIds: ['101'], readThrough: reactionBoundary });
    await fixture.whenStable();
    http.expectNone(`/_api/chats/${wireChat.id}/reactions/read`);
    reactionNotification(encodeId('102'));
    http.expectNone(`/_api/chats/${wireChat.id}/reactions`);
    cover(false);
    fixture.detectChanges();
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions`)
      .flush({ messageIds: ['101', '102'], readThrough: reactionBoundary });
    await Promise.resolve();
    await Promise.resolve();
    const ack = http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`);
    expect(ack.request.body.readThrough).toBe(reactionBoundary);
    ack.flush({ unreadReactions: 0 });
    await fixture.whenStable();
    expect(component['reactionJumpIds']()).toEqual([encodeId('102'), encodeId('101')]);
  });

  it('fetches reaction IDs and acknowledges the conversation on entry', async () => {
    useReactionHttp();
    const chatInfo = TestBed.inject(ChatStore);
    vi.spyOn(chatInfo, 'unreadReactions').mockReturnValue(2);
    const applied = vi.spyOn(chatInfo, 'applyReactionRead').mockImplementation(() => {});
    const ids = [encodeId('102'), encodeId('101')];

    component.ionViewDidEnter();
    await Promise.resolve();
    const reactions = http.expectOne(`/_api/chats/${wireChat.id}/reactions`);
    reactions.flush({ messageIds: ids.map(decodeId), readThrough: reactionBoundary });
    await Promise.resolve();
    await Promise.resolve();

    const ack = http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`);
    expect(ack.request.body).toEqual({ threadId: undefined, readThrough: reactionBoundary });
    ack.flush({ unreadReactions: 0 });
    await Promise.resolve();

    expect(applied).toHaveBeenCalledWith(testChat.id, undefined, 0);
    expect(component['reactionJumpIds']()).toEqual(ids);
    expect(component['canJumpReaction']()).toBe(true);
  });

  it('fetches mention IDs on entry without acknowledging', async () => {
    useMentionHttp();
    const chatInfo = TestBed.inject(ChatStore);
    vi.spyOn(chatInfo, 'unreadMentions').mockReturnValue(2);
    const ids = [encodeId('202'), encodeId('201')];

    component.ionViewDidEnter();
    await Promise.resolve();
    await notificationSettled();
    http.expectOne(`/_api/chats/${wireChat.id}/mentions`).flush({ messageIds: ids.map(decodeId) });
    await Promise.resolve();
    await Promise.resolve();

    expect(component['mentionJumpIds']()).toEqual(ids);
    expect(component['canJumpMention']()).toBe(true);
    http.expectNone(`/_api/chats/${wireChat.id}/reactions/read`);
  });

  it('shares lifecycle requests and keeps mention targets through healthy foreground restores', async () => {
    useMentionHttp();
    const first = component['enterMentionSession']();
    const second = component['enterMentionSession']();
    expect(second).toBe(first);
    const request = http.expectOne(`/_api/chats/${wireChat.id}/mentions`);
    request.flush({ messageIds: ['201'] });
    await first;
    await component['enterMentionSession']();
    component['visibilityChanged']();
    await notificationSettled();
    http.expectNone(`/_api/chats/${wireChat.id}/mentions`);
    expect(component['mentionJumpIds']()).toEqual([encodeId('201')]);
  });

  it('skips a confirmed zero but reads unknown counts, cancelling the query when the page leaves', async () => {
    useMentionHttp();
    const known = vi.spyOn(TestBed.inject(ChatStore), 'cachedUnreadMentions').mockReturnValue(0);
    await component['enterMentionSession']();
    http.expectNone(`/_api/chats/${wireChat.id}/mentions`);
    component['resetMentionSession']();
    known.mockReturnValue(undefined);
    const reading = component['enterMentionSession']();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/mentions`);
    component['leave'](true);
    expect(request.cancelled).toBe(true);
    await reading;
  });

  it('removes withdrawn mention targets before jumping and ignores them in delayed snapshots', async () => {
    useMentionHttp();
    const reading = component['enterMentionSession']();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/mentions`);
    events.next({
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: { chatId: testChat.id, messageIds: [encodeId('201'), encodeId('202')] },
    });
    request.flush({ messageIds: ['203', '202', '201'] });
    await reading;
    expect(component['mentionJumpIds']()).toEqual([encodeId('203')]);
    const jump = vi.fn().mockResolvedValue(true);
    component['goTo'] = jump;
    await component['jumpToNextMention']();
    expect(jump).toHaveBeenCalledOnce();
    expect(component['mentionJumpIds']()).toEqual([]);
  });

  it('refreshes mention IDs on a mention notification while the conversation is active', async () => {
    useMentionHttp();
    const chatInfo = TestBed.inject(ChatStore);
    vi.spyOn(chatInfo, 'unreadMentions').mockReturnValue(0);

    events.next({
      type: ServerWsMessageType.notification,
      payload: {
        notificationType: NotificationType.mention,
        chatId: testChat.id,
        messageId: testMessage.id,
        threadRootId: undefined,
        actorUid: 2,
      },
    });
    await Promise.resolve();
    await notificationSettled();
    http.expectOne(`/_api/chats/${wireChat.id}/mentions`).flush({ messageIds: [decodeId(testMessage.id)] });
    await Promise.resolve();
    await Promise.resolve();

    expect(component['mentionJumpIds']()).toEqual([testMessage.id]);
    http.expectNone(`/_api/chats/${wireChat.id}/reactions/read`);
  });

  it('acknowledges a reaction notification received while the conversation is active', async () => {
    useReactionHttp();
    const chatInfo = TestBed.inject(ChatStore);
    vi.spyOn(chatInfo, 'applyReactionRead').mockImplementation(() => {});

    events.next({
      type: ServerWsMessageType.notification,
      payload: {
        notificationType: NotificationType.reaction,
        chatId: testChat.id,
        messageId: testMessage.id,
        threadRootId: undefined,
        actorUid: 2,
      },
    });
    await Promise.resolve();
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions`)
      .flush({ messageIds: [decodeId(testMessage.id)], readThrough: reactionBoundary });
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`).flush({ unreadReactions: 0 });
    await Promise.resolve();

    expect(component['reactionJumpIds']()).toEqual([testMessage.id]);
  });

  it('acknowledges reactions again when leaving the conversation', async () => {
    useReactionHttp();
    const chatInfo = TestBed.inject(ChatStore);
    vi.spyOn(chatInfo, 'unreadReactions').mockReturnValue(2);
    vi.spyOn(chatInfo, 'applyReactionRead').mockImplementation(() => {});

    component.ionViewDidEnter();
    await Promise.resolve();
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions`)
      .flush({ messageIds: [decodeId(testMessage.id)], readThrough: reactionBoundary });
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`).flush({ unreadReactions: 0 });
    await Promise.resolve();

    component.ionViewWillLeave();
    await Promise.resolve();
    http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`).flush({ unreadReactions: 0 });
    await Promise.resolve();
  });

  it('discards a delayed reaction target cleared by reading, but allows a later reaction on that message', async () => {
    useReactionHttp();
    reactionNotification(encodeId('101'));
    const snapshot = http.expectOne(`/_api/chats/${wireChat.id}/reactions`);
    component['reactionJumpIds'].set([encodeId('101')]);
    const changes = TestBed.inject(ChatStore) as unknown as {
      changes: { next: (change: object) => void };
    };
    changes.changes.next({ kind: ChatChangeKind.Read, chatId: testChat.id, readThrough: encodeId('101') });
    expect(component['reactionJumpIds']()).toEqual([]);
    snapshot.flush({ messageIds: ['101', '102'], readThrough: reactionBoundary });
    await notificationSettled();
    http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`).flush({ unreadReactions: 0 });
    await notificationSettled();
    expect(component['reactionJumpIds']()).toEqual([encodeId('102')]);

    reactionNotification(encodeId('101'));
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions`)
      .flush({ messageIds: ['101'], readThrough: reactionBoundary });
    await notificationSettled();
    http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`).flush({ unreadReactions: 0 });
    await notificationSettled();
    expect(component['reactionJumpIds']()).toEqual([encodeId('102'), encodeId('101')]);
  });

  it('preserves unvisited reaction targets when another notification arrives', async () => {
    useReactionHttp();
    reactionNotification(encodeId('101'));
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions`)
      .flush({ messageIds: ['101'], readThrough: reactionBoundary });
    await notificationSettled();
    http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`).flush({ unreadReactions: 0 });
    await notificationSettled();
    reactionNotification(encodeId('102'));
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions`)
      .flush({ messageIds: ['102'], readThrough: reactionBoundary });
    await notificationSettled();
    http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`).flush({ unreadReactions: 0 });
    await notificationSettled();
    expect(component['reactionJumpIds']()).toEqual([encodeId('102'), encodeId('101')]);
  });

  it('shares reaction lifecycle refreshes without scheduling a second snapshot', async () => {
    useReactionHttp();
    component['visibilityChanged']();
    component['visibilityChanged']();
    const snapshot = http.expectOne(`/_api/chats/${wireChat.id}/reactions`);
    snapshot.flush({ messageIds: ['101'], readThrough: reactionBoundary });
    await notificationSettled();
    component['visibilityChanged']();
    http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`).flush({ unreadReactions: 0 });
    await notificationSettled();
    component['visibilityChanged']();
    http.expectNone(`/_api/chats/${wireChat.id}/reactions`);
    expect(component['reactionJumpIds']()).toEqual([encodeId('101')]);
  });

  it('skips a fresh known zero reaction count but still fetches a new notification', async () => {
    useReactionHttp();
    vi.spyOn(TestBed.inject(ChatStore), 'cachedUnreadReactions').mockReturnValue(0);
    component['visibilityChanged']();
    http.expectNone(`/_api/chats/${wireChat.id}/reactions`);
    reactionNotification();
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions`)
      .flush({ messageIds: ['101'], readThrough: reactionBoundary });
    await notificationSettled();
    http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`).flush({ unreadReactions: 0 });
    await notificationSettled();
  });

  it('requeries a notification received between the reaction snapshot and its acknowledgement', async () => {
    useReactionHttp();
    reactionNotification(encodeId('101'));
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions`)
      .flush({ messageIds: ['101'], readThrough: reactionBoundary });
    reactionNotification(encodeId('102'));
    await notificationSettled();
    const ack = http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`);
    expect(ack.request.body.readThrough).toBe(reactionBoundary);
    ack.flush({ unreadReactions: 1 });
    await notificationSettled();
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions`)
      .flush({ messageIds: ['102'], readThrough: '2026-10-20T00:00:01Z' });
    await notificationSettled();
    const nextAck = http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`);
    expect(nextAck.request.body.readThrough).toBe('2026-10-20T00:00:01Z');
    nextAck.flush({ unreadReactions: 0 });
    await notificationSettled();
    expect(component['reactionJumpIds']()).toEqual([encodeId('102'), encodeId('101')]);
  });

  it('defers hidden notifications until the page becomes visible', async () => {
    useReactionHttp();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    reactionNotification();
    http.expectNone(`/_api/chats/${wireChat.id}/reactions`);
    http.expectNone(`/_api/chats/${wireChat.id}/reactions/read`);
    hidden.mockReturnValue(false);
    component['visibilityChanged']();
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions`)
      .flush({ messageIds: [wireMessage.id], readThrough: reactionBoundary });
    await notificationSettled();
    http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`).flush({ unreadReactions: 0 });
    await notificationSettled();
  });

  it('does not acknowledge a snapshot that finishes after the document becomes hidden', async () => {
    useReactionHttp();
    reactionNotification();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions`)
      .flush({ messageIds: [wireMessage.id], readThrough: reactionBoundary });
    await notificationSettled();
    http.expectNone(`/_api/chats/${wireChat.id}/reactions/read`);
  });

  it('acknowledges the saved scope after navigation changes the active route', async () => {
    useReactionHttp();
    reactionNotification();
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions`)
      .flush({ messageIds: [wireMessage.id], readThrough: reactionBoundary });
    await notificationSettled();
    http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`).flush({ unreadReactions: 0 });
    await notificationSettled();
    vi.mocked(TestBed.inject(Router).isActive).mockReturnValue(false);
    component.ionViewWillLeave();
    const ack = http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`);
    expect(ack.request.body.readThrough).toBeUndefined();
    ack.flush({ unreadReactions: 0 });
    await notificationSettled();
  });

  it('loads both notification scopes on direct thread entry without cached counts', async () => {
    await enterThread();
    useReactionHttp();
    useMentionHttp();
    component.ionViewDidEnter();
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions?threadId=100`)
      .flush({ messageIds: ['101'], readThrough: reactionBoundary });
    await notificationSettled();
    http.expectOne(`/_api/chats/${wireChat.id}/mentions?threadId=100`).flush({ messageIds: ['102'] });
    await notificationSettled();
    const ack = http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`);
    expect(ack.request.body.threadId).toBe('100');
    ack.flush({ unreadReactions: 0 });
    await notificationSettled();
    expect(component['reactionRemaining']()).toBe(1);
    expect(component['mentionRemaining']()).toBe(1);
  });

  it('refreshes a thread on reconnect even when cached notification counts are zero', async () => {
    await enterThread();
    vi.spyOn(component['conversation'], 'reconnect').mockResolvedValue();
    useReactionHttp();
    useMentionHttp();
    resync.next();
    http.expectOne('/_api/users/me/notification-settings').flush(testUser);
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat, myRole: GroupRole.member });
    for (const request of http.match(`/_api/chats/${wireChat.id}/messages/100`)) {
      request.flush({ ...wireMessage, id: '100' });
    }
    http
      .expectOne(`/_api/chats/${wireChat.id}/reactions?threadId=100`)
      .flush({ messageIds: ['101'], readThrough: reactionBoundary });
    await notificationSettled();
    http.expectOne(`/_api/chats/${wireChat.id}/mentions?threadId=100`).flush({ messageIds: [] });
    await notificationSettled();
    http.expectOne(`/_api/chats/${wireChat.id}/reactions/read`).flush({ unreadReactions: 0 });
    await notificationSettled();
    expect(component['reactionRemaining']()).toBe(1);
  });

  it('coalesces mention notifications during a fetch and retains their targets', async () => {
    useMentionHttp();
    const notify = () =>
      events.next({
        type: ServerWsMessageType.notification,
        payload: {
          notificationType: NotificationType.mention,
          chatId: testChat.id,
          messageId: testMessage.id,
          threadRootId: undefined,
          actorUid: 2,
        },
      });
    notify();
    notify();
    await notificationSettled();
    const first = http.expectOne(`/_api/chats/${wireChat.id}/mentions`);
    notify();
    first.flush({ messageIds: ['101'] });
    await notificationSettled();
    http.expectOne(`/_api/chats/${wireChat.id}/mentions`).flush({ messageIds: ['102', '101'] });
    await notificationSettled();
    expect(component['mentionJumpIds']()).toEqual([encodeId('102'), encodeId('101')]);
  });

  it('keeps the server reaction cursor unchanged when fetching targets fails', async () => {
    useReactionHttp();
    reactionNotification();
    http.expectOne(`/_api/chats/${wireChat.id}/reactions`).flush({}, { status: 500, statusText: 'Failed' });
    await notificationSettled();
    http.expectNone(`/_api/chats/${wireChat.id}/reactions/read`);
  });

  it('marks only a visible message bottom and stops tracking hidden or departed pages', async () => {
    const markRead = TestBed.inject(ChatStore).markRead;
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    const opening = component['conversation'].open(encodeId('101'));
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=101`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [100, 101, 102].map((id) => ({ ...wireMessage, id: String(id) })),
    });
    await opening;
    await fixture.whenStable();
    const elements = [...fixture.nativeElement.querySelectorAll('app-message')] as HTMLElement[];
    const rects = [new DOMRect(0, 0, 300, 60), new DOMRect(0, 60, 300, 80), new DOMRect(0, 140, 300, 400)];
    elements.forEach((element, index) => vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rects[index]));
    component.ionViewDidEnter();
    await component['trackScroll']();
    expect(markRead).toHaveBeenLastCalledWith(testChat.id, encodeId('101'));
    vi.mocked(markRead).mockClear();
    hidden.mockReturnValue(true);
    await component['trackScroll']();
    expect(markRead).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    component.ionViewDidLeave();
    await component['trackScroll']();
    expect(markRead).not.toHaveBeenCalled();
    expect(component['conversation'].items()).toEqual([]);
    expect(fixture.nativeElement.querySelectorAll('app-message')).toHaveLength(0);
    expect(component['rows']()).toEqual([]);
  });

  it('updates the read boundary when a pending row is confirmed in place and then deleted', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    const first: HTMLElement = fixture.nativeElement.querySelector('app-message');
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 60));
    typeText('等待确认');
    const sending = component['sendMessage']();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    await fixture.whenStable();
    const local: HTMLElement = fixture.nativeElement.querySelector('.message-list > app-message:last-child');
    vi.spyOn(local, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 60, 300, 60));
    component.ionViewDidEnter();
    await fixture.whenStable();
    const markRead = vi.mocked(TestBed.inject(ChatStore).markRead);
    markRead.mockClear();
    await component['trackScroll']();
    expect(markRead).toHaveBeenLastCalledWith(testChat.id, testMessage.id);

    const confirmedId = encodeId('9007199254741010');
    request.flush({
      ...wireMessage,
      id: decodeId(confirmedId),
      clientGeneratedId: request.request.body.clientGeneratedId,
    });
    await sending;
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.message-list > app-message:last-child')).toBe(local);
    markRead.mockClear();
    await component['trackScroll']();
    expect(markRead).toHaveBeenLastCalledWith(testChat.id, confirmedId);

    component['conversation'].delete(confirmedId);
    await fixture.whenStable();
    markRead.mockClear();
    await component['trackScroll']();
    expect(markRead).toHaveBeenLastCalledWith(testChat.id, testMessage.id);
  });

  it('keeps live messages and pins on healthy foreground while calibrating group metadata', async () => {
    component.ionViewDidEnter();
    await fixture.whenStable();
    const pins = vi.mocked(TestBed.inject(PinsService).listPins);
    pins.mockClear();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const message = { ...testMessage, id: encodeId('9007199254741004'), clientGeneratedId: 'background' };
    incoming.next(message);
    await fixture.whenStable();
    expect(component['conversation'].items()).toContainEqual(message);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    resync.next(ResyncReason.Foreground);
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat, name: '新群名' });
    await fixture.whenStable();
    expect(pins).not.toHaveBeenCalled();
    expect(TestBed.inject(ChatStore).getReadState).not.toHaveBeenCalled();
    http.expectNone((request) => request.url.includes('/messages'));
    expect(fixture.nativeElement.querySelector('ion-title').textContent).toContain('新群名');
  });

  it('reuses a successful DM receipt on foreground and retries failed receipt reads', async () => {
    const dm = { ...testChat, kind: GroupKind.dm };
    TestBed.inject(ChatStore).remember([dm]);
    await fixture.whenStable();
    const url = `/_api/chats/${wireChat.id}/read-receipt`;
    http.expectOne(url).flush({ lastReadMessageId: wireMessage.id });
    await fixture.whenStable();
    resync.next(ResyncReason.Foreground);
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat, kind: GroupKind.dm });
    await fixture.whenStable();
    http.expectNone(url);
    expect(component['isReadByPeer'](testMessage)).toBe(true);
    events.next({ type: ServerWsMessageType.readReceiptChanged, payload: { chatId: testChat.id, readerUid: 2 } });
    http.expectOne(url).flush('', { status: 503, statusText: 'Unavailable' });
    await fixture.whenStable();
    resync.next(ResyncReason.Foreground);
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat, kind: GroupKind.dm });
    http.expectOne(url).flush({ lastReadMessageId: wireMessage.id });
    await fixture.whenStable();
  });

  it('refreshes metadata and reports the visible read position through the unified resync event', async () => {
    const data = TestBed.inject(ChatStore);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    fixture.detectChanges();
    const message: HTMLElement = fixture.nativeElement.querySelector('app-message');
    vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 100));
    component.ionViewDidEnter();
    await fixture.whenStable();
    document.dispatchEvent(new Event('visibilitychange'));
    await fixture.whenStable();
    expect(data.getReadState).not.toHaveBeenCalled();
    vi.mocked(data.markRead).mockClear();

    resync.next();
    http.expectOne('/_api/users/me/notification-settings').flush(testUser);
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&after=${wireMessage.id}`)
      .flush({ chatSettings: { showMembershipMessages: true }, messages: [] });
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat, name: '重连后的群名称' });
    await fixture.whenStable();
    expect(data.getReadState).toHaveBeenCalledOnce();
    expect(data.getReadState).toHaveBeenCalledWith(testChat.id);
    expect(data.markRead).toHaveBeenLastCalledWith(testChat.id, testMessage.id);
    expect(fixture.nativeElement.querySelector('ion-title').textContent).toContain('重连后的群名称');
  });

  it('refreshes deep-linked topic subscription state on resync without reloading the topic list', async () => {
    await enterThread();
    const loadSubscription = TestBed.inject(ChatStore).loadSubscription;
    vi.mocked(loadSubscription).mockClear();
    resync.next();
    http.expectOne('/_api/users/me/notification-settings').flush(testUser);
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&after=102&threadId=100`)
      .flush({ chatSettings: { showMembershipMessages: true }, messages: [] });
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat });
    subscriptions.update((statuses) => new Map(statuses).set(encodeId('100'), { subscribed: true, archived: false }));
    await fixture.whenStable();
    expect(component['subscription']()).toEqual({ subscribed: true, archived: false });
    expect(loadSubscription).toHaveBeenCalledWith(testChat.id, encodeId('100'));
    expect(TestBed.inject(ChatStore).getReadState).not.toHaveBeenCalled();
  });

  it('retries a failed page without reloading the resume position', async () => {
    let loading = component['loadPage'](PageDirection.Older);
    await Promise.resolve();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`)
      .flush('', { status: 503, statusText: 'Unavailable' });
    await loading;
    expect(component['conversation'].error()).toBe(ConversationError.Page);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('加载消息失败');
    // A scroll at the opposite end has nothing to load and must not replace the failed action.
    await component['loadPage'](PageDirection.Newer);
    component['retry']();
    await Promise.resolve();
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage, id: '9007199254741001' }],
      olderCursor: null,
    });
    await fixture.whenStable();
    expect(component['conversation'].items()).toHaveLength(2);
    expect(component['conversation'].error()).toBeUndefined();
  });

  it('keeps main chat messages separate from topics and routes a root message into its topic', async () => {
    incoming.next({ ...testMessage, id: encodeId('9007199254741005'), replyRootId: testMessage.id });
    expect(component['conversation'].items()).toEqual([testMessage]);
    events.next({
      type: ServerWsMessageType.threadUpdate,
      payload: {
        chatId: testChat.id,
        threadRootId: testMessage.id,
        replyCount: 2,
        lastReplyAt: testMessage.createdAt,
      },
    });
    await fixture.whenStable();
    expect(component['conversation'].items()[0].threadInfo).toEqual({ replyCount: 2 });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.detectChanges();
    const button: HTMLElement = fixture.nativeElement.querySelector('app-message .thread-entry');
    expect(button).not.toBeNull();
    button.click();
    expect(navigate).toHaveBeenCalledWith(['/chats/chat', wireChat.id, 'thread', wireMessage.id]);
  });

  it('resumes a deep-linked topic at its own read boundary and resets drafts between topics', async () => {
    component['draft'].set('主会话草稿');
    await enterThread();
    expect(component.threadId()).toBe(encodeId('100'));
    expect(TestBed.inject(DraftStore).get(testChat.id)?.text).toBe('主会话草稿');
    expect(TestBed.inject(DraftStore).get(testChat.id, encodeId('100'))).toBeUndefined();
    expect(component['draft']()).toBe('');
    expect(component['firstUnreadId']()).toBe(encodeId('102'));
    expect(fixture.nativeElement.querySelector('.conversation-name').textContent.trim()).toBe('测试消息');
    expect(component['showBackToChat']()).toBe(true);
    component['draft'].set('话题草稿');
    await enterThread('99', {});
    expect(component['draft']()).toBe('');
    expect(component['entryReadId']()).toBe(encodeId('99'));
    expect(component['firstUnreadId']()).toBe(encodeId('101'));
    expect(TestBed.inject(ChatStore).getReadState).not.toHaveBeenCalled();
  });

  it('receives and marks only the active topic without advancing the main chat read position', async () => {
    await enterThread();
    incoming.next({ ...testMessage, id: encodeId('103') });
    incoming.next({ ...testMessage, id: encodeId('104'), replyRootId: encodeId('99') });
    incoming.next({ ...testMessage, id: encodeId('105'), replyRootId: encodeId('100') });
    expect(component['conversation'].items().map((item) => item.id)).toEqual([
      encodeId('100'),
      encodeId('101'),
      encodeId('102'),
      encodeId('105'),
    ]);
    await fixture.whenStable();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    const elements = [...fixture.nativeElement.querySelectorAll('app-message')] as HTMLElement[];
    elements.forEach((element, index) =>
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, index * 50, 300, 50)),
    );
    component.ionViewDidEnter();
    await component['trackScroll']();
    expect(TestBed.inject(ChatStore).markThreadRead).toHaveBeenLastCalledWith(
      testChat.id,
      encodeId('100'),
      encodeId('105'),
    );
    expect(TestBed.inject(ChatStore).markRead).not.toHaveBeenCalled();
    const open = vi.spyOn(component['conversation'], 'open');
    TestBed.inject(ConversationNavigation).goTo(testChat.id, { type: ConversationTargetKind.Latest });
    expect(open).not.toHaveBeenCalled();
    TestBed.inject(ConversationNavigation).goTo(testChat.id, { type: ConversationTargetKind.Latest }, encodeId('100'));
    expect(open).toHaveBeenCalledWith(undefined, false, false);
  });

  it('fetches the topic read boundary once its cached list snapshot is stale', async () => {
    const readState = vi.mocked(TestBed.inject(ChatStore).threadReadState);
    readState.mockReturnValue({ lastReadMessageId: encodeId('100') });
    fixture.componentRef.setInput('threadId', '100');
    fixture.detectChanges();
    for (const req of http.match(`/_api/chats/${wireChat.id}/messages/100`)) req.flush({ ...wireMessage, id: '100' });
    http.expectNone(`/_api/chats/${wireChat.id}/threads/100/read-state`);
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=100&threadId=100`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        { ...wireMessage, id: '100' },
        { ...wireMessage, id: '101', replyRootId: '100', sender: otherSender },
      ],
    });
    await fixture.whenStable();
    expect(component['entryReadId']()).toBe(encodeId('100'));
    component.ionViewDidLeave();
    readState.mockReturnValue(undefined);
    component.ionViewWillEnter();
    if (component.threadId())
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(component.threadId()!)}`))
        req.flush({ ...wireMessage, id: decodeId(component.threadId()!) });
    http
      .expectOne(`/_api/chats/${wireChat.id}/threads/100/read-state`)
      .flush({ lastReadMessageId: '101', unreadCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=101&threadId=100`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        { ...wireMessage, id: '101', replyRootId: '100', sender: otherSender },
        { ...wireMessage, id: '102', replyRootId: '100', sender: otherSender },
      ],
    });
    await fixture.whenStable();
    expect(readState).toHaveBeenLastCalledWith(testChat.id, encodeId('100'));
    expect(component['entryReadId']()).toBe(encodeId('101'));
    expect(component['firstUnreadId']()).toBe(encodeId('102'));
  });

  it('publishes accepted topic replies without turning the sender’s own message into an unread divider', async () => {
    await enterThread('100', { lastReadMessageId: '102' });
    expect(component['firstUnreadId']()).toBeUndefined();
    expect(fixture.nativeElement.querySelector('.unread-separator')).toBeNull();
    const accept = vi.spyOn(TestBed.inject(Connection), 'accept');
    component['draft'].set('话题消息');
    const sending = component['sendMessage']();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/threads/100/messages`);
    expect(request.request.body.message).toBe('话题消息');
    expect(component['draft']()).toBe('');
    expect(component['rows']().at(-1)?.outgoing?.threadId).toBe(encodeId('100'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.unread-separator')).toBeNull();
    request.flush({
      ...wireMessage,
      id: '103',
      replyRootId: '100',
      clientGeneratedId: request.request.body.clientGeneratedId,
      message: request.request.body.message,
    });
    await sending;
    await fixture.whenStable();
    expect(component['conversation'].items().at(-1)?.id).toBe(encodeId('103'));
    expect(component['draft']()).toBe('');
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ id: encodeId('103'), replyRootId: encodeId('100') }));
    expect(component['firstUnreadId']()).toBeUndefined();
    expect(fixture.nativeElement.querySelector('.unread-separator')).toBeNull();
  });

  it('uses the inbox subscription as the only state for following, archiving and restoring a topic', async () => {
    await enterThread();
    const inbox = TestBed.inject(ChatStore);
    await component['updateThread']();
    expect(inbox.subscribeThread).toHaveBeenCalledWith(testChat.id, encodeId('100'));
    expect(component['subscription']()).toEqual({ subscribed: false, archived: false });
    subscriptions.update((statuses) => new Map(statuses).set(encodeId('100'), { subscribed: true, archived: false }));
    expect(component['subscription']()).toEqual({ subscribed: true, archived: false });
    await component['updateThread']();
    expect(inbox.setThreadArchived).toHaveBeenLastCalledWith(testChat.id, encodeId('100'), true);
    expect(component['subscription']()).toEqual({ subscribed: true, archived: false });
    subscriptions.update((statuses) => new Map(statuses).set(encodeId('100'), { subscribed: true, archived: true }));
    expect(component['subscription']()).toEqual({ subscribed: true, archived: true });
    await component['updateThread']();
    expect(inbox.setThreadArchived).toHaveBeenLastCalledWith(testChat.id, encodeId('100'), false);
    subscriptions.update((statuses) => new Map(statuses).set(encodeId('100'), { subscribed: true, archived: false }));
    expect(component['subscription']()).toEqual({ subscribed: true, archived: false });
  });

  it('keeps a new topic draft when an earlier topic send finishes after navigation', async () => {
    await enterThread();
    component['draft'].set('第一话题消息');
    const sending = component['sendMessage']();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/threads/100/messages`);
    const item = component['outbox'].items()[0];
    expect(component['draft']()).toBe('');
    await enterThread('99');
    expect(request.cancelled).toBe(false);
    expect(component['outbox'].items()).toContain(item);
    expect(component['rows']().some((row) => row.outgoing === item)).toBe(false);
    component['draft'].set('另一个话题草稿');
    request.flush({
      ...wireMessage,
      id: '103',
      replyRootId: '100',
      clientGeneratedId: request.request.body.clientGeneratedId,
      message: request.request.body.message,
    });
    await sending;
    expect(component['draft']()).toBe('另一个话题草稿');
    expect(item.delivery()).toBe(MessageDelivery.Sent);
    expect(item.published()).toBe(true);
    expect(component['outbox'].items()).toContain(item);
    expect(TestBed.inject(DraftStore).get(testChat.id, encodeId('100'))).toBeUndefined();
    expect(component['conversation'].items().map((item) => item.id)).toEqual([
      encodeId('99'),
      encodeId('101'),
      encodeId('102'),
    ]);
  });

  it('shows the subscribe action before the status arrives and acts on what it showed', async () => {
    await enterThread();
    subscriptions.set(new Map());
    expect(component['subscription']()).toBeUndefined();
    expect(component['threadAction']()).toMatchObject({ label: 'conversation.actions.subscribeThread' });
    const inbox = TestBed.inject(ChatStore);
    const loading = deferred<void>();
    vi.mocked(inbox.loadSubscription).mockImplementationOnce(() => {
      subscriptions.set(new Map([[encodeId('100'), { subscribed: true, archived: false }]]));
      return loading.promise;
    });
    const updating = component['updateThread']();
    expect(component['threadUpdating']()).toBe(true);
    loading.resolve();
    await updating;
    // The thread turned out to be subscribed, so the tap that read 订阅 does not archive it.
    expect(inbox.subscribeThread).not.toHaveBeenCalled();
    expect(inbox.setThreadArchived).not.toHaveBeenCalled();
    expect(component['threadUpdating']()).toBe(false);
  });

  it('keeps live chat metadata independent of filtered chat and thread lists', async () => {
    const chatInfo = TestBed.inject(ChatStore);
    chatInfo.remember([{ ...testChat, name: '话题所属群' }]);
    vi.mocked(TestBed.inject(ChatStore).cachedReadState).mockReturnValue(undefined);
    await enterThread();
    expect(fixture.nativeElement.querySelector('ion-title').textContent).toContain('测试消息');
    subscriptions.update((statuses) => new Map(statuses).set(encodeId('100'), { subscribed: true, archived: true }));
    await component['updateThread']();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-title').textContent).toContain('测试消息');
    chatInfo.remember([{ ...testChat, name: '群名称更新' }]);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-title').textContent).toContain('测试消息');
  });

  it('loads a missing canonical subscription after the owner invalidates it', async () => {
    await enterThread();
    const loadSubscription = TestBed.inject(ChatStore).loadSubscription;
    vi.mocked(loadSubscription).mockClear();
    subscriptions.set(new Map());
    await fixture.whenStable();
    expect(loadSubscription).toHaveBeenCalledOnce();
    expect(loadSubscription).toHaveBeenCalledWith(testChat.id, encodeId('100'));
    expect(component['subscription']()).toBeUndefined();
  });

  it('keeps shared chat state when leaving while releasing the page message window', async () => {
    const sharedPins = component['pins']();
    component.ionViewDidLeave();
    expect(component['conversation'].items()).toEqual([]);
    expect(TestBed.inject(ChatStore).get(testChat.id)?.name).toBe(testChat.name);
    await reenter();
    expect(component['pins']()).toBe(sharedPins);
  });

  it.each(['success', 'failure'])(
    'preserves the next draft while resolving an earlier send %s across reentry',
    async (result) => {
      const accept = vi.spyOn(TestBed.inject(Connection), 'accept');
      component['draft'].set('第一次进入的消息');
      const oldSending = component['sendMessage']();
      const oldRequest = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
      const oldItem = component['outbox'].items()[0];
      component.ionViewDidLeave();
      expect(oldRequest.cancelled).toBe(false);
      await reenter();
      expect(component['draft']()).toBe('');
      expect(component['rows']().at(-1)?.outgoing).toBe(oldItem);
      component['draft'].set('再次进入的消息');
      component['replyTo'].set(testMessage);
      void component['sendMessage']();
      const newItem = component['outbox'].items().at(-1)!;
      expect(
        component['rows']()
          .slice(-2)
          .map((row) => row.outgoing),
      ).toEqual([oldItem, newItem]);
      expect(component['draft']()).toBe('');
      expect(component['replyTo']()).toBeUndefined();
      http.expectNone((req) => req.method === 'POST');
      component['updateDraft']('第三条尚未发送');
      component['startReply'](testMessage);
      const open = vi.spyOn(component['conversation'], 'open');
      if (result === 'success')
        oldRequest.flush({
          ...wireMessage,
          id: '9007199254741005',
          clientGeneratedId: oldRequest.request.body.clientGeneratedId,
          message: oldRequest.request.body.message,
        });
      else oldRequest.flush('', { status: 503, statusText: 'Unavailable' });
      await oldSending;
      expect(oldItem.delivery()).toBe(result === 'success' ? MessageDelivery.Sent : MessageDelivery.Failed);
      const newRequest = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
      expect(newRequest.request.body.clientGeneratedId).toBe(newItem.clientGeneratedId);
      expect(newRequest.request.body.message).toBe('再次进入的消息');
      expect(newRequest.request.body.replyToId).toBe(wireMessage.id);
      expect(oldItem.delivery()).toBe(result === 'success' ? MessageDelivery.Sent : MessageDelivery.Failed);
      expect(component['draft']()).toBe('第三条尚未发送');
      expect(component['replyTo']()).toBe(testMessage);
      expect(open).not.toHaveBeenCalled();
      expect(accept).toHaveBeenCalledTimes(result === 'success' ? 1 : 0);
      newRequest.flush('', { status: 503, statusText: 'Unavailable' });
      await vi.waitFor(() => expect(newItem.delivery()).toBe(MessageDelivery.Failed));
      await fixture.whenStable();
      expect(newItem.delivery()).toBe(MessageDelivery.Failed);
      expect(component['rows']().at(-1)?.outgoing).toBe(newItem);
      expect(component['draft']()).toBe('第三条尚未发送');
      expect(component['replyTo']()).toBe(testMessage);
    },
  );

  it('does not report a subscription failure from an earlier visit to the same topic', async () => {
    await enterThread();
    const pending = deferred<void>();
    vi.mocked(TestBed.inject(ChatStore).loadSubscription).mockReturnValueOnce(pending.promise);
    const loading = component['loadSubscription']();
    component.ionViewDidLeave();
    await reenter();
    pending.reject(new Error('Previous visit failed'));
    await loading;
    expect(component['threadError']()).toBeUndefined();
  });

  it('keeps a new topic action busy when a previous visit’s action finishes', async () => {
    await enterThread();
    const oldAction = deferred<void>();
    const newAction = deferred<void>();
    vi.mocked(TestBed.inject(ChatStore).subscribeThread)
      .mockReturnValueOnce(oldAction.promise)
      .mockReturnValueOnce(newAction.promise);
    const oldUpdating = component['updateThread']();
    component.ionViewDidLeave();
    await reenter();
    expect(component['threadUpdating']()).toBe(false);
    const newUpdating = component['updateThread']();
    oldAction.reject(new Error('Previous action failed'));
    await oldUpdating;
    expect(component['threadUpdating']()).toBe(true);
    expect(component['threadError']()).toBeUndefined();
    newAction.reject(new Error('Current action failed'));
    await newUpdating;
    expect(component['threadUpdating']()).toBe(false);
    expect(component['threadError']()).toBe(ThreadError.Update);
  });

  it('ignores an unfinished scroll event after reentering the same chat', async () => {
    const pendingScroll = deferred<HTMLElement>();
    vi.mocked(IonContent.prototype.getScrollElement).mockReturnValueOnce(pendingScroll.promise);
    const scrolling = component['onScroll']();
    component.ionViewDidLeave();
    await reenter();
    component.ionViewDidEnter();
    await fixture.whenStable();
    const load = vi.spyOn(component['conversation'], 'load');
    scroll.scrollTop = 0;
    pendingScroll.resolve(scroll);
    await scrolling;
    expect(load).not.toHaveBeenCalled();
    http.expectNone(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`);
  });

  it('continues queued sends after page destruction and hands confirmations to the next page', async () => {
    const outbox = TestBed.inject(MessageOutbox);
    component['draft'].set('销毁前第一条');
    const firstSending = component['sendMessage']();
    const firstRequest = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    component['draft'].set('销毁前第二条');
    void component['sendMessage']();
    const [first, second] = outbox.items();
    const oldConversation = component['conversation'];
    fixture.destroy();
    expect(firstRequest.cancelled).toBe(false);
    expect(outbox.items()).toEqual([first, second]);
    firstRequest.flush({
      ...wireMessage,
      id: '9007199254741005',
      clientGeneratedId: firstRequest.request.body.clientGeneratedId,
      message: firstRequest.request.body.message,
    });
    await firstSending;
    const secondRequest = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    expect(secondRequest.request.body.clientGeneratedId).toBe(second.clientGeneratedId);
    secondRequest.flush({
      ...wireMessage,
      id: '9007199254741007',
      clientGeneratedId: secondRequest.request.body.clientGeneratedId,
      message: secondRequest.request.body.message,
    });
    await vi.waitFor(() => expect(second.published()).toBe(true));
    expect(first.published()).toBe(true);
    expect(second.published()).toBe(true);
    expect(oldConversation.items()).toEqual([]);
    expect(outbox.items()).toEqual([first, second]);

    fixture = TestBed.createComponent(ConversationPage);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('id', wireChat.id);
    fixture.detectChanges();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50`)
      .flush({ chatSettings: { showMembershipMessages: true }, messages: [structuredClone(wireMessage)] });
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component['outbox']).toBe(outbox);
    expect(component['draft']()).toBe('');
    expect(component['conversation'].items().map((message) => message.id)).toEqual([
      testMessage.id,
      encodeId('9007199254741005'),
      encodeId('9007199254741007'),
    ]);
    expect(fixture.debugElement.queryAll(By.directive(Message))).toHaveLength(3);
    expect(outbox.items()).toEqual([]);
  });

  it('cancels a topic read-state request when the page is destroyed', async () => {
    fixture.componentRef.setInput('threadId', '100');
    fixture.detectChanges();
    for (const req of http.match(`/_api/chats/${wireChat.id}/messages/100`)) req.flush({ ...wireMessage, id: '100' });
    const request = http.expectOne(`/_api/chats/${wireChat.id}/threads/100/read-state`);
    fixture.destroy();
    expect(request.cancelled).toBe(true);
    await Promise.resolve();
    expect(component['conversation'].items()).toEqual([]);
    http.expectNone(`/_api/chats/${wireChat.id}/messages?max=50&around=100&threadId=100`);
  });

  it.each(['hash', 'query'])(
    'repositions on every repeated %s message link without replacing the page',
    async (kind) => {
      const router = TestBed.inject(Router);
      router.resetConfig([{ path: 'chats/chat/:id', children: [] }]);
      const jump = vi
        .spyOn(component as unknown as { goTo: (typeof component)['goTo'] }, 'goTo')
        .mockResolvedValue(undefined);
      const suffix = kind === 'hash' ? `#msg=${wireMessage.id}` : `?message=${wireMessage.id}`;
      const url = `/chats/chat/${wireChat.id}${suffix}`;
      fixture.componentRef.setInput('message', wireMessage.id);
      await router.navigateByUrl(url);
      fixture.detectChanges();
      await fixture.whenStable();
      jump.mockClear();
      component['draft'].set('未发送的内容');
      const row = fixture.nativeElement.querySelector('app-message');
      for (let count = 1; count <= 2; count++) {
        expect(await router.navigateByUrl(url)).toBe(false);
        expect(jump).toHaveBeenCalledTimes(count);
        expect(jump).toHaveBeenLastCalledWith({ type: ConversationTargetKind.Message, messageId: testMessage.id });
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('app-message')).toBe(row);
        expect(component['draft']()).toBe('未发送的内容');
        expect(router.url).toBe(url);
      }
      http.expectNone(() => true);
    },
  );

  it.each(['inactive', 'other conversation', 'no message target'])(
    'does not repeat message positioning for %s',
    async (condition) => {
      const router = TestBed.inject(Router);
      router.resetConfig([{ path: 'chats/chat/:id', children: [] }]);
      const jump = vi
        .spyOn(component as unknown as { goTo: (typeof component)['goTo'] }, 'goTo')
        .mockResolvedValue(undefined);
      const url = `/chats/chat/${wireChat.id}` + (condition === 'no message target' ? '' : `#msg=${wireMessage.id}`);
      if (condition !== 'no message target') fixture.componentRef.setInput('message', wireMessage.id);
      await router.navigateByUrl(url);
      fixture.detectChanges();
      await fixture.whenStable();
      if (condition === 'inactive') component['active'].set(false);
      if (condition === 'other conversation') vi.mocked(router.isActive).mockReturnValue(false);
      jump.mockClear();
      await router.navigateByUrl(url);
      expect(jump).not.toHaveBeenCalled();
    },
  );

  it('locates a message from a shared query URL without falling back to the read boundary', async () => {
    const animate = vi.fn();
    Object.defineProperty(Element.prototype, 'animate', { value: animate, configurable: true });
    const id = '9007199254741999';
    fixture.componentRef.setInput('message', id);
    fixture.detectChanges();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=${id}`)
      .flush({ chatSettings: { showMembershipMessages: true }, messages: [{ ...wireMessage, id }] });
    await fixture.whenStable();
    expect(component['conversation'].items()[0].id).toBe(encodeId(id));
    expect(component['conversation'].error()).toBeUndefined();
    fixture.detectChanges();
    await component['positionAndRead']();
    fixture.componentRef.setInput('message', 'invalid');
    fixture.detectChanges();
    expect(component.message()).toBeUndefined();
    http.expectNone(() => true);
    fixture.destroy();
    Reflect.deleteProperty(Element.prototype, 'animate');
  });

  it('allows selecting the next reply while a submitted reply is still sending', async () => {
    component['replyTo'].set(testMessage);
    component['draft'].set('正在回复');
    const sending = component['sendMessage']();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    const item = component['outbox'].items()[0];
    const nextReply = { ...testMessage, id: encodeId('999'), clientGeneratedId: 'next-reply-999' };
    component['startReply'](nextReply);
    expect(component['replyTo']()).toBe(nextReply);
    expect(item.message().replyToMessage).toMatchObject(testMessage);
    expect(request.request.body.replyToId).toBe(wireMessage.id);
    request.flush('', { status: 503, statusText: 'Unavailable' });
    await sending;
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    expect(component['draft']()).toBe('');
    expect(component['replyTo']()).toBe(nextReply);
  });

  it.each([false, true])('selects the original reply on a fresh collection link, retrying: %s', async (retrying) => {
    Object.defineProperty(Element.prototype, 'animate', { value: vi.fn(), configurable: true });
    const focus = vi.spyOn(IonTextarea.prototype, 'setFocus').mockResolvedValue();
    const id = '9007199254741999';
    fixture.destroy();
    fixture = TestBed.createComponent(ConversationPage);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('id', wireChat.id);
    fixture.componentRef.setInput('reply', id);
    fixture.detectChanges();
    let request = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=${id}`);
    if (retrying) {
      request.flush('', { status: 503, statusText: 'Unavailable' });
      await vi.waitFor(() => expect(component['conversation'].error()).toBe(ConversationError.Open));
      expect(component['replyTo']()).toBeUndefined();
      component['retry']();
      request = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=${id}`);
    }
    request.flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...structuredClone(wireMessage), id, message: '原会话最新内容' }],
    });
    await vi.waitFor(() => expect(component['replyTo']()).toMatchObject({ id: encodeId(id) }));
    await fixture.whenStable();
    expect(component['replyTo']()).toBe(component['conversation'].items()[0]);
    expect(component['replyTo']()?.message).toBe('原会话最新内容');
    expect(focus).toHaveBeenCalled();
    fixture.componentRef.setInput('reply', 'invalid');
    fixture.detectChanges();
    expect(component.reply()).toBeUndefined();
    http.expectNone(() => true);
    fixture.destroy();
    Reflect.deleteProperty(Element.prototype, 'animate');
  });

  it('applies remote edits and recall to the current conversation through the change stream', () => {
    events.next({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, message: '更新后的正文', isEdited: true },
    });
    expect(component['conversation'].items()[0].message).toBe('更新后的正文');
    events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } });
    expect(component['conversation'].items()[0].isDeleted).toBe(true);
    fixture.detectChanges();
    expect(component['rows']()).toEqual([]);
    expect(fixture.nativeElement.querySelector('app-message, .message-date')).toBeNull();
    expect(fixture.nativeElement.querySelector('.message-list').textContent).not.toContain('消息已删除');
  });

  it('omits deleted history and paging-time recalls before grouping dates and avatars', async () => {
    const loading = component['conversation'].load(PageDirection.Older);
    events.next({
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: {
        chatId: testChat.id,
        messageIds: [encodeId('9007199254741001')],
      },
    });
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        {
          ...wireMessage,
          id: '9007199254740999',
          clientGeneratedId: 'deleted-history',
          isDeleted: true,
          createdAt: '2026-09-04T12:00:00Z',
        },
        { ...wireMessage, id: '9007199254741000', clientGeneratedId: 'visible-history' },
        {
          ...wireMessage,
          id: '9007199254741001',
          clientGeneratedId: 'recalled-history',
          sender: { uid: 2, name: '朋友', gender: 0 },
        },
      ],
    });
    await loading;
    fixture.detectChanges();
    expect(
      component['rows']().map(({ message, first, last, dateBreak }) => ({ id: message.id, first, last, dateBreak })),
    ).toEqual([
      { id: encodeId('9007199254741000'), first: true, last: false, dateBreak: true },
      { id: testMessage.id, first: false, last: true, dateBreak: false },
    ]);
    expect(fixture.nativeElement.querySelectorAll('app-message')).toHaveLength(2);
    expect(fixture.nativeElement.querySelectorAll('.message-date')).toHaveLength(1);
    expect(component['conversation'].page()?.olderCursor).toBeUndefined();
  });

  it('skips own messages when finding the unread divider, including after a recall', async () => {
    component['entryReadId'].set(encodeId('9007199254741000'));
    expect(component['firstUnreadId']()).toBeUndefined();
    const first = {
      ...testMessage,
      id: encodeId('9007199254741004'),
      clientGeneratedId: 'first-unread',
      sender: otherSender,
    };
    incoming.next(first);
    incoming.next({ ...testMessage, id: encodeId('9007199254741005'), clientGeneratedId: 'own-reply' });
    expect(component['firstUnreadId']()).toBe(first.id);
    events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...first, isDeleted: true } });
    await fixture.whenStable();
    expect(component['firstUnreadId']()).toBeUndefined();
    expect(fixture.nativeElement.querySelector('.unread-separator')).toBeNull();
    const second = { ...first, id: encodeId('9007199254741006'), clientGeneratedId: 'second-unread' };
    const third = { ...first, id: encodeId('9007199254741007'), clientGeneratedId: 'third-unread' };
    incoming.next(second);
    incoming.next(third);
    expect(component['firstUnreadId']()).toBe(second.id);
    events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...second, isDeleted: true } });
    expect(component['firstUnreadId']()).toBe(third.id);
  });

  it('keeps a recalled thread root as a tombstone row with its topic entry', async () => {
    const root = {
      ...testMessage,
      id: encodeId('9007199254741101'),
      clientGeneratedId: 'thread-root',
      message: '话题根',
      threadInfo: { replyCount: 2 },
      sender: otherSender,
    };
    incoming.next(root);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('app-message')).toHaveLength(2);
    component['entryReadId'].set(encodeId('9007199254741003'));
    expect(component['firstUnreadId']()).toBe(root.id);
    events.next({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...root, isDeleted: true, message: undefined, mentions: [], attachments: [], reactions: [] },
    });
    fixture.detectChanges();
    expect(component['rows']().map((row) => row.message.id)).toEqual([testMessage.id, root.id]);
    expect(fixture.nativeElement.querySelectorAll('app-message')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('.message-list').textContent).toContain('消息已删除');
    expect(fixture.nativeElement.querySelectorAll('.thread-entry')).toHaveLength(1);
    // A tombstone is row content, not a read boundary.
    expect(component['firstUnreadId']()).toBeUndefined();
  });

  it('keeps a recalled pin while its topic is still reachable and drops one without a topic', async () => {
    const root = {
      ...testMessage,
      id: encodeId('9007199254741201'),
      message: '话题根',
      threadInfo: { replyCount: 1 },
    };
    pinMessage('301', root);
    pinMessage('302');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.pinned-bar').textContent).toContain('话题根');
    events.next({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...testMessage, isDeleted: true, message: undefined, mentions: [], attachments: [], reactions: [] },
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.pinned-bar').textContent).toContain('话题根');
    events.next({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...root, isDeleted: true, message: undefined, mentions: [], attachments: [], reactions: [] },
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.pinned-bar').textContent).toContain('消息已删除');
    expect(component['selectedPin']()?.message.id).toBe(root.id);
  });

  it('removes a recalled message when the local delete request succeeds', async () => {
    const recalling = component['menu']()!['messageActions'].recall(testMessage);
    http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`).flush(null);
    await recalling;
    fixture.detectChanges();
    expect(component['rows']()).toEqual([]);
    expect(fixture.nativeElement.querySelector('app-message, .message-date')).toBeNull();
  });

  it('does not submit a sixth personal reaction', async () => {
    await component['menu']()!['reactTo'](
      {
        ...testMessage,
        reactions: ['👍', '❤️', '😂', '😮', '😢'].map((emoji) => ({ emoji, count: 1, reactedByMe: true })),
      },
      '🎉',
    );
    expect(component['menu']()!['notice']()).toBe(MessageNotice.ReactionLimit);
    http.expectNone(() => true);
  });
  it('passes reactive avatar preferences to message children', () => {
    component['stickySender'].set(testMessage.sender);
    component['stickyRow'].set(0);
    fixture.detectChanges();
    const message = fixture.debugElement.query(By.directive(Message)).componentInstance as Message;
    expect(message.showAllAvatars()).toBe(false);
    expect(message.stickyAvatar()).toBe(true);
    expect(fixture.nativeElement.querySelector('.sticky-avatar')).not.toBeNull();
    avatars.set(true);
    fixture.detectChanges();
    expect(message.showAllAvatars()).toBe(true);
    expect(message.stickyAvatar()).toBe(false);
    expect(fixture.nativeElement.querySelector('.sticky-avatar')).toBeNull();
    avatars.set(false);
    fixture.detectChanges();
    expect(message.stickyAvatar()).toBe(true);
    expect(fixture.nativeElement.querySelector('.sticky-avatar')).not.toBeNull();
  });

  it('resolves an ID-only menu selection against the latest message', async () => {
    TestBed.inject(ChatStore).invalidate();
    const details = TestBed.inject(ChatStore).ensureDetails(testChat.id);
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...structuredClone(wireChat), myRole: GroupRole.member });
    await details;
    component['menu']()!['selection'].set({
      messageId: testMessage.id,
      element: document.createElement('div'),
      rect: new DOMRect(),
      own: false,
    });
    events.next({ type: ServerWsMessageType.messageUpdated, payload: { ...testMessage, message: '编辑后的消息' } });
    fixture.detectChanges();
    expect(component['menu']()!['message']()?.message).toBe('编辑后的消息');
    expect(component['menu']()!['selection']()).not.toHaveProperty('message');
  });
  it('enqueues an edit and immediately restores the separate unsent draft and reply', async () => {
    component['updateDraft']('未发送的草稿');
    component['startReply'](testMessage);
    component['startEdit'](testMessage);
    component['updateDraft']('编辑内容');
    const sending = component['sendMessage']({ messageType: MessageType.text, attachmentIds: [encodeId('100')] });
    const item = component['outbox'].items()[0];
    expect(item.editId).toBe(testMessage.id);
    expect(item.threadId).toBeUndefined();
    expect(component['editing']()).toBeUndefined();
    expect(component['draft']()).toBe('未发送的草稿');
    expect(component['replyTo']()).toBe(testMessage);
    expect(component['savedReplyId']()).toBeUndefined();
    fixture.detectChanges();
    expect(component['composer']()!.text()).toBe('未发送的草稿');
    expect(component['rows']()).toHaveLength(1);
    expect(component['rows']()[0].outgoing).toBe(item);
    expect(component['rows']()[0].message.message).toBe('编辑内容');
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ message: '编辑内容', attachmentIds: ['100'] });
    http.expectNone((req) => req.method === 'POST');
    request.flush({ ...wireMessage, message: '编辑内容', isEdited: true });
    await sending;
    await fixture.whenStable();
    expect(component['conversation'].items()[0].message).toBe('编辑内容');
    expect(component['rows']()).toHaveLength(1);
    expect(component['draft']()).toBe('未发送的草稿');
    expect(component['replyTo']()).toBe(testMessage);
    expect(component['outbox'].items()).toEqual([]);
  });

  it('edits a pending outgoing item in place and immediately restores the unsent draft and reply', async () => {
    const outbox = TestBed.inject(MessageOutbox);
    const media = pendingUpload();
    const composition = { messageType: MessageType.text, attachmentIds: [], uploads: [media.upload] };
    component['updateDraft']('原待发消息');
    const sending = component['sendMessage'](composition);
    const item = outbox.items()[0];
    fixture.detectChanges();
    const originalRows = fixture.debugElement.queryAll(By.directive(Message));
    const local = originalRows.at(-1)!;
    const rowKeys = component['rows']().map((row) => row.key);
    expect(originalRows).toHaveLength(2);
    expect(local.nativeElement.textContent).toContain('原待发消息');
    http.expectNone((request) => request.method === 'POST' || request.method === 'PATCH');

    const edit = vi.spyOn(outbox, 'edit');
    const enqueue = vi.spyOn(outbox, 'enqueue');
    const enqueueEdit = vi.spyOn(outbox, 'enqueueEdit');
    component['updateDraft']('未提交的下一条草稿');
    component['startReply'](testMessage);
    component['startEdit'](item);
    fixture.detectChanges();
    expect(component['editing']()?.message).toBe('原待发消息');
    expect(component['composer']()!.text()).toBe('原待发消息');
    typeText('  修改后的待发消息  ');
    const editing = component['sendMessage'](composition);
    const operation = item.operation;
    expect(edit).toHaveBeenCalledExactlyOnceWith(item, '修改后的待发消息', composition);
    expect(enqueue).not.toHaveBeenCalled();
    expect(enqueueEdit).not.toHaveBeenCalled();
    expect(outbox.items()).toEqual([item]);
    expect(component['editing']()).toBeUndefined();
    expect(component['draft']()).toBe('未提交的下一条草稿');
    expect(component['replyTo']()).toBe(testMessage);
    fixture.detectChanges();
    expect(component['composer']()!.text()).toBe('未提交的下一条草稿');
    expect(component['rows']().map((row) => row.key)).toEqual(rowKeys);
    expect(component['rows']().at(-1)?.outgoing).toBe(item);
    expect(fixture.debugElement.queryAll(By.directive(Message)).map((row) => row.nativeElement)).toEqual(
      originalRows.map((row) => row.nativeElement),
    );
    expect((local.componentInstance as Message<MessageContent>).message().message).toBe('修改后的待发消息');
    expect(local.nativeElement.textContent).toContain('修改后的待发消息');
    http.expectNone((request) => request.method === 'POST' || request.method === 'PATCH');
    typeText('编辑退出后继续写草稿');

    media.finish(encodeId('100'));
    const request = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    expect(request.request.method).toBe('POST');
    expect(request.request.body.message).toBe('修改后的待发消息');
    expect(request.request.body.attachmentIds).toEqual(['100']);
    request.flush({
      ...wireMessage,
      id: '9007199254741005',
      clientGeneratedId: request.request.body.clientGeneratedId,
      message: '修改后的待发消息',
      hasAttachments: true,
      attachments: [{ id: '100', url: media.upload.url, fileName: 'edit.png', kind: 'image/png', size: 5 }],
    });
    await Promise.all([sending, editing, operation]);
    await vi.waitFor(() => expect(item.delivery()).toBe(MessageDelivery.Sent));
    await fixture.whenStable();
    expect(component['rows']()).toHaveLength(2);
    expect(fixture.debugElement.queryAll(By.directive(Message)).at(-1)!.nativeElement).toBe(local.nativeElement);
    expect((local.componentInstance as Message<MessageContent>).message().message).toBe('修改后的待发消息');
    expect(component['draft']()).toBe('编辑退出后继续写草稿');
    expect(component['replyTo']()).toBe(testMessage);
    expect(component['composer']()!.text()).toBe('编辑退出后继续写草稿');
    expect(outbox.items()).toEqual([]);
    http.expectNone((request) => request.method === 'POST' || request.method === 'PATCH');
  });

  it('preserves an open outgoing edit through upload changes and create acknowledgement, then PATCHes the released item', async () => {
    const outbox = TestBed.inject(MessageOutbox);
    const retained = pendingUpload('retained.png');
    const removed = pendingUpload('removed.png');
    const added = pendingUpload('added.png');
    component['updateDraft']('创建时的正文');
    const sending = component['sendMessage']({
      messageType: MessageType.text,
      attachmentIds: [],
      uploads: [retained.upload, removed.upload],
    });
    const item = outbox.items()[0];
    component['updateDraft']('下一条未发送草稿');
    component['startReply'](testMessage);
    component['startEdit'](item);
    fixture.detectChanges();
    const local = fixture.debugElement.queryAll(By.directive(Message)).at(-1)!;
    const composer = component['composer']()!;
    expect(composer['selectedUploads']()).toEqual([retained.upload, removed.upload]);
    composer['remove'](removed.upload);
    composer['uploads'].set([added.upload]);
    typeText('确认前已经改写的正文');
    expect(composer['selectedUploads']()).toEqual([retained.upload, added.upload]);
    expect(removed.upload.dispose).not.toHaveBeenCalled();

    retained.progress(0.75);
    added.progress(0.5);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component['editing']()).toBeDefined();
    expect(component['editText']()).toBe('确认前已经改写的正文');
    expect(composer.text()).toBe('确认前已经改写的正文');
    expect(composer['selectedUploads']()).toEqual([retained.upload, added.upload]);
    expect(added.upload.dispose).not.toHaveBeenCalled();
    const selected: HTMLElement = fixture.nativeElement.querySelector('app-message-composer .uploads');
    expect([...selected.querySelectorAll('img')].map((image) => image.src)).toEqual([
      retained.upload.url,
      added.upload.url,
    ]);

    retained.finish(encodeId('100'));
    removed.finish(encodeId('101'));
    const create = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    expect(create.request.method).toBe('POST');
    expect(create.request.body.message).toBe('创建时的正文');
    expect(create.request.body.attachmentIds).toEqual(['100', '101']);
    fixture.detectChanges();
    expect(composer.text()).toBe('确认前已经改写的正文');
    expect(composer['selectedUploads']()).toEqual([retained.upload, added.upload]);
    const attachment = (id: string, upload: AttachmentUpload) => ({
      id,
      url: upload.url,
      fileName: upload.file.name,
      kind: upload.file.type,
      size: upload.file.size,
    });
    const created = {
      ...wireMessage,
      id: '9007199254741005',
      clientGeneratedId: create.request.body.clientGeneratedId,
      message: '创建时的正文',
      hasAttachments: true,
      attachments: [attachment('100', retained.upload), attachment('101', removed.upload)],
    };
    create.flush(structuredClone(created));
    await sending;
    await vi.waitFor(() => expect(item.delivery()).toBe(MessageDelivery.Sent));
    await fixture.whenStable();
    expect(item.confirmed()?.id).toBe(encodeId(created.id));
    expect(item.disposed).toBe(true);
    expect(outbox.items()).toEqual([]);
    expect(component['rows']()).toHaveLength(2);
    expect(fixture.debugElement.queryAll(By.directive(Message)).at(-1)!.nativeElement).toBe(local.nativeElement);
    expect(component['editing']()).toBeDefined();
    expect(component['editText']()).toBe('确认前已经改写的正文');
    expect(composer.text()).toBe('确认前已经改写的正文');
    expect(composer['selectedUploads']()).toEqual([retained.upload, added.upload]);
    expect(added.upload.dispose).not.toHaveBeenCalled();
    expect([...selected.querySelectorAll('img')].map((image) => image.src)).toEqual([
      retained.upload.url,
      added.upload.url,
    ]);

    const edit = vi.spyOn(outbox, 'edit');
    const enqueue = vi.spyOn(outbox, 'enqueue');
    typeText('确认前已经改写的正文，确认后继续补充');
    const send: HTMLButtonElement = fixture.nativeElement.querySelector('.send-button');
    expect(send.disabled).toBe(false);
    send.click();
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      item,
      '确认前已经改写的正文，确认后继续补充',
      expect.objectContaining({ messageType: MessageType.text, uploads: [retained.upload, added.upload] }),
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(component['editing']()).toBeUndefined();
    expect(component['draft']()).toBe('下一条未发送草稿');
    expect(component['replyTo']()).toBe(testMessage);
    const patchItem = outbox.items()[0];
    fixture.detectChanges();
    expect(composer.text()).toBe('下一条未发送草稿');
    expect(component['rows']()).toHaveLength(2);
    expect(added.upload.dispose).not.toHaveBeenCalled();
    http.expectNone((request) => request.method === 'POST');
    added.finish(encodeId('102'));
    const patch = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages/${created.id}`));
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({
      message: '确认前已经改写的正文，确认后继续补充',
      attachmentIds: ['100', '102'],
    });
    patch.flush({
      ...created,
      message: '确认前已经改写的正文，确认后继续补充',
      isEdited: true,
      attachments: [attachment('100', retained.upload), attachment('102', added.upload)],
    });
    await vi.waitFor(() => expect(patchItem.delivery()).toBe(MessageDelivery.Sent));
    await fixture.whenStable();
    expect(component['rows']()).toHaveLength(2);
    expect(fixture.debugElement.queryAll(By.directive(Message)).at(-1)!.nativeElement).toBe(local.nativeElement);
    expect((local.componentInstance as Message<MessageContent>).message().message).toBe(
      '确认前已经改写的正文，确认后继续补充',
    );
    expect(component['draft']()).toBe('下一条未发送草稿');
    expect(component['replyTo']()).toBe(testMessage);
    expect(outbox.items()).toEqual([]);
    http.expectNone((request) => request.method === 'POST' || request.method === 'PATCH');
  });

  it('hands off unfinished edit uploads immediately, overlays the original row and PATCHes only after upload', async () => {
    const newer = {
      ...testMessage,
      id: encodeId('9007199254741005'),
      clientGeneratedId: 'newer-edit-neighbor',
      message: '后面的消息',
    };
    incoming.next(newer);
    fixture.detectChanges();
    const originalRows = fixture.debugElement.queryAll(By.directive(Message));
    const original = originalRows[0];
    const message = original.componentInstance as Message<MessageContent>;
    const neighbor = originalRows[1].componentInstance as Message<MessageContent>;
    const media = pendingUpload();
    component['updateDraft']('未发送的草稿');
    component['startReply'](newer);
    component['startEdit'](testMessage);
    fixture.detectChanges();
    const composer = component['composer']()!;
    composer['uploads'].set([media.upload]);
    typeText('带附件的编辑');
    const send: HTMLButtonElement = fixture.nativeElement.querySelector('.send-button');
    expect(send.disabled).toBe(false);
    send.click();
    const item = component['outbox'].items()[0];
    const operation = item.operation;
    expect(item.editId).toBe(testMessage.id);
    expect(item.uploads).toEqual([media.upload]);
    expect(component['editing']()).toBeUndefined();
    expect(component['draft']()).toBe('未发送的草稿');
    expect(component['replyTo']()).toBe(newer);
    expect(component['savedReplyId']()).toBeUndefined();
    expect(composer['uploads']()).toEqual([]);
    expect(media.upload.retry).toHaveBeenCalledOnce();
    http.expectNone((req) => req.method === 'PATCH' || req.method === 'POST');
    fixture.detectChanges();
    expect(composer.text()).toBe('未发送的草稿');
    expect(media.upload.dispose).not.toHaveBeenCalled();
    expect(component['outbox'].items()).toEqual([item]);
    expect(component['rows']().map((row) => row.message.id)).toEqual([testMessage.id, newer.id]);
    expect(fixture.debugElement.queryAll(By.directive(Message)).map((row) => row.nativeElement)).toEqual(
      originalRows.map((row) => row.nativeElement),
    );
    expect(message.message()).toMatchObject({
      id: testMessage.id,
      message: '带附件的编辑',
      createdAt: testMessage.createdAt,
    });
    expect(message.message().attachments).toEqual([
      expect.objectContaining({ url: media.upload.url, fileName: 'edit.png' }),
    ]);
    expect(original.nativeElement.textContent).toContain('带附件的编辑');
    expect(message.delivery()).toBe(MessageDelivery.Sending);
    expect(neighbor.interactive()).toBe(true);
    expect(neighbor.canReply()).toBe(true);
    const openMenu = vi.spyOn(component['menu']()!, 'open').mockImplementation(() => {});
    originalRows[1].query(By.css('.bubble')).triggerEventHandler('contextmenu', new MouseEvent('contextmenu'));
    expect(openMenu).toHaveBeenCalledOnce();
    expect(openMenu).toHaveBeenCalledWith(expect.objectContaining({ messageId: newer.id }));
    expect((fixture.nativeElement.querySelector('.attach-button') as HTMLButtonElement).disabled).toBe(false);
    expect((fixture.nativeElement.querySelector('.reply-close') as HTMLButtonElement).disabled).toBe(false);
    typeText('上传期间的新草稿');
    expect(component['draft']()).toBe('上传期间的新草稿');
    expect((fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement).disabled).toBe(false);

    media.finish(encodeId('100'));
    const request = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`));
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ message: '带附件的编辑', attachmentIds: ['100'] });
    request.flush({
      ...wireMessage,
      message: '带附件的编辑',
      isEdited: true,
      hasAttachments: true,
      attachments: [{ id: '100', url: media.upload.url, fileName: 'edit.png', kind: 'image/png', size: 5 }],
    });
    await operation;
    await vi.waitFor(() => expect(item.delivery()).toBe(MessageDelivery.Sent));
    await fixture.whenStable();
    expect(fixture.debugElement.queryAll(By.directive(Message)).map((row) => row.nativeElement)).toEqual(
      originalRows.map((row) => row.nativeElement),
    );
    expect(message.message().message).toBe('带附件的编辑');
    expect(message.interactive()).toBe(true);
    expect(component['outbox'].items()).toEqual([]);
    expect(media.upload.dispose).toHaveBeenCalledOnce();
    expect(component['draft']()).toBe('上传期间的新草稿');
    expect(component['replyTo']()).toBe(newer);
  });

  it('retries a failed edit from its original row without clearing the next draft or reply', async () => {
    const newer = { ...testMessage, id: encodeId('9007199254741005'), clientGeneratedId: 'edit-retry-neighbor' };
    incoming.next(newer);
    component['startEdit'](testMessage);
    component['updateDraft']('需要重试的编辑');
    const sending = component['sendMessage']();
    const item = component['outbox'].items()[0];
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`);
    fixture.detectChanges();
    const original = fixture.debugElement.queryAll(By.directive(Message))[0];
    typeText('新的未发送草稿');
    component['startReply'](newer);
    request.flush('', { status: 503, statusText: 'Unavailable' });
    await sending;
    await fixture.whenStable();
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    expect(component['editing']()).toBeUndefined();
    expect(component['rows']().map((row) => row.message.id)).toEqual([testMessage.id, newer.id]);
    expect(fixture.debugElement.queryAll(By.directive(Message))[0].nativeElement).toBe(original.nativeElement);
    expect(original.nativeElement.textContent).toContain('需要重试的编辑');
    expect(component['draft']()).toBe('新的未发送草稿');
    expect(component['replyTo']()).toBe(newer);
    const retry: HTMLButtonElement = original.nativeElement.querySelector('.retry-button');
    expect(retry).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.retry-button')).toHaveLength(1);
    retry.click();
    const operation = item.operation;
    const retried = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`);
    expect(retried.request.method).toBe('PATCH');
    expect(retried.request.body).toEqual(request.request.body);
    expect(component['outbox'].items()).toEqual([item]);
    expect(item.delivery()).toBe(MessageDelivery.Sending);
    fixture.detectChanges();
    expect(original.nativeElement.querySelector('.retry-button')).toBeNull();
    typeText('重试期间继续输入');
    expect(component['replyTo']()).toBe(newer);
    retried.flush({ ...wireMessage, message: '需要重试的编辑', isEdited: true });
    await operation;
    await fixture.whenStable();
    expect(component['rows']()).toHaveLength(2);
    expect(fixture.debugElement.queryAll(By.directive(Message))[0].nativeElement).toBe(original.nativeElement);
    expect(original.nativeElement.textContent).toContain('需要重试的编辑');
    expect(original.nativeElement.querySelector('.retry-button')).toBeNull();
    expect((original.componentInstance as Message<MessageContent>).interactive()).toBe(true);
    expect(component['outbox'].items()).toEqual([]);
    expect(component['draft']()).toBe('重试期间继续输入');
    expect(component['replyTo']()).toBe(newer);
    expect(component['composer']()!.text()).toBe('重试期间继续输入');
    http.expectNone((req) => req.method === 'POST');
  });

  it.each(['navigation', 'destroy'])(
    'keeps an edit confirmation effective after %s and hands it to the returning page',
    async (mode) => {
      const outbox = TestBed.inject(MessageOutbox);
      const acceptChange = vi.spyOn(TestBed.inject(Connection), 'acceptChange');
      component['updateDraft']('原会话未发送草稿');
      component['startEdit'](testMessage);
      component['updateDraft']('离开后完成的编辑');
      const sending = component['sendMessage']();
      const item = outbox.items()[0];
      const request = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`);
      const otherChatId = encodeId('9007199254740995');
      const otherMessage = {
        ...testMessage,
        id: encodeId('9007199254741010'),
        chatId: otherChatId,
        clientGeneratedId: 'other-chat-message',
        message: '另一个会话的消息',
      };
      TestBed.inject(ChatStore).remember([{ ...testChat, id: otherChatId }]);
      if (mode === 'destroy') {
        fixture.destroy();
        fixture = TestBed.createComponent(ConversationPage);
        component = fixture.componentInstance;
      }
      fixture.componentRef.setInput('id', decodeId(otherChatId));
      fixture.detectChanges();
      http.expectOne(`/_api/group/${decodeId(otherChatId)}`).flush({ ...wireChat, id: decodeId(otherChatId) });
      http.expectOne(`/_api/chats/${decodeId(otherChatId)}/messages?max=50`).flush({
        chatSettings: { showMembershipMessages: true },
        messages: [{ ...otherMessage, id: decodeId(otherMessage.id), chatId: decodeId(otherChatId) }],
      });
      await fixture.whenStable();
      expect(request.cancelled).toBe(false);
      expect(outbox.items()).toContain(item);
      expect(TestBed.inject(DraftStore).get(testChat.id)?.text).toBe('原会话未发送草稿');
      typeText('另一个会话的新草稿');
      component['startReply'](otherMessage);
      component['startEdit'](otherMessage);
      component['updateDraft']('另一个会话正在编辑');
      request.flush({ ...wireMessage, message: '离开后完成的编辑', isEdited: true });
      await sending;
      await fixture.whenStable();
      expect(item.delivery()).toBe(MessageDelivery.Sent);
      expect(item.confirmed()).toMatchObject({ id: testMessage.id, message: '离开后完成的编辑', isEdited: true });
      expect(acceptChange).toHaveBeenCalledWith({
        type: ServerWsMessageType.messageUpdated,
        payload: expect.objectContaining({ id: testMessage.id, message: '离开后完成的编辑' }),
      });
      expect(component['conversation'].items()).toEqual([otherMessage]);
      expect(component['rows']()).toHaveLength(1);
      expect(component['draft']()).toBe('另一个会话的新草稿');
      expect(component['replyTo']()).toBe(otherMessage);
      expect(component['editing']()).toBe(otherMessage);
      expect(component['composer']()!.text()).toBe('另一个会话正在编辑');

      fixture.componentRef.setInput('id', wireChat.id);
      fixture.detectChanges();
      // A stale initial GET must not erase a confirmation retained by the shared outbox.
      http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`).flush({
        chatSettings: { showMembershipMessages: true },
        messages: [structuredClone(wireMessage)],
      });
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(component['outbox']).toBe(outbox);
      expect(component['rows']()).toHaveLength(1);
      expect(component['rows']()[0].message).toMatchObject({
        id: testMessage.id,
        message: '离开后完成的编辑',
        isEdited: true,
      });
      expect(fixture.debugElement.queryAll(By.directive(Message))).toHaveLength(1);
      const returned: HTMLElement = fixture.nativeElement.querySelector('app-message');
      expect(returned.textContent).toContain('离开后完成的编辑');
      expect(component['draft']()).toBe('原会话未发送草稿');
      expect(component['editing']()).toBeUndefined();
      expect(outbox.items()).toContain(item);
      events.next({
        type: ServerWsMessageType.messageUpdated,
        payload: { ...testMessage, message: '离开后完成的编辑', isEdited: true },
      });
      await fixture.whenStable();
      expect(component['conversation'].items()[0].message).toBe('离开后完成的编辑');
      expect(fixture.nativeElement.querySelector('app-message')).toBe(returned);
      expect(component['rows']()).toHaveLength(1);
      expect(outbox.items()).toEqual([]);
      http.expectNone((req) => req.method === 'PATCH' || req.method === 'POST');
    },
  );

  it.each([MessageType.file, MessageType.audio, MessageType.sticker])(
    'preserves unsent text while a %s submission clears its reply and retains a retryable row',
    async (messageType) => {
      component['updateDraft']('稍后发送的文字');
      component['startReply'](testMessage);
      const sticker =
        messageType === MessageType.sticker
          ? {
              id: encodeId('102'),
              createdAt: testMessage.createdAt,
              emoji: '🙂',
              isFavorited: false,
              media: {
                id: encodeId('103'),
                contentType: 'image/png',
                size: 1,
                url: 'data:image/png;base64,iVBORw0KGgo=',
              },
            }
          : undefined;
      const attachmentIds = sticker ? [] : [encodeId('101')];
      const sending = component['sendMessage']({ messageType, attachmentIds, sticker });
      const item = component['outbox'].items()[0];
      const request = http.expectOne((req) => req.method === 'POST' && req.url.endsWith('/messages'));
      expect(request.request.body.messageType).toBe(messageType);
      expect(request.request.body.message).toBeUndefined();
      expect(request.request.body.attachmentIds).toEqual(sticker ? [] : ['101']);
      expect(request.request.body.stickerId).toBe(sticker ? '102' : undefined);
      expect(request.request.body.replyToId).toBe(wireMessage.id);
      expect(component['draft']()).toBe('稍后发送的文字');
      expect(component['replyTo']()).toBeUndefined();
      expect(component['rows']().at(-1)?.outgoing).toBe(item);
      request.flush('', { status: 503, statusText: 'Unavailable' });
      await sending;
      fixture.detectChanges();
      expect(item.delivery()).toBe(MessageDelivery.Failed);
      expect(component['draft']()).toBe('稍后发送的文字');
      expect(component['replyTo']()).toBeUndefined();
      expect(fixture.nativeElement.querySelector('app-message:last-child .retry-button')).not.toBeNull();
      const retrying = component['outbox'].retry(item);
      const retry = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
      expect(retry.request.body).toEqual(request.request.body);
      retry.flush({
        ...wireMessage,
        id: '9007199254741010',
        messageType,
        message: null,
        clientGeneratedId: retry.request.body.clientGeneratedId,
      });
      await retrying;
      expect(item.delivery()).toBe(MessageDelivery.Sent);
      expect(component['draft']()).toBe('稍后发送的文字');
      expect(component['replyTo']()).toBeUndefined();
    },
  );
  it('shares the authorized conversation receipt with the cached list preview', async () => {
    const chats = TestBed.inject(ChatStore);
    const dm = { ...testChat, kind: GroupKind.dm };
    chats.acceptChats([dm], chats.snapshot());
    const oldListVersion = chats.snapshot();
    fixture.detectChanges();
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`).flush({ lastReadMessageId: wireMessage.id });
    await fixture.whenStable();
    expect(component['isReadByPeer'](testMessage)).toBe(true);
    expect(chats.chat(testChat.id).peerLastReadMessageId).toBe(testMessage.id);
    chats.acceptChats([dm], oldListVersion);
    expect(chats.chat(testChat.id).peerLastReadMessageId).toBe(testMessage.id);
  });

  it('keeps an authorized DM receipt through ordinary invalidation and clears it immediately for privacy changes', async () => {
    TestBed.inject(ChatStore).remember([{ ...testChat, kind: GroupKind.dm }]);
    fixture.detectChanges();
    const initial = http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`);
    initial.flush({ lastReadMessageId: wireMessage.id });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component['readReceiptId']()).toBe(testMessage.id);
    expect(fixture.debugElement.query(By.directive(Message)).componentInstance.read()).toBe(true);

    events.next({ type: ServerWsMessageType.readReceiptChanged, payload: { chatId: testChat.id } });
    expect(component['readReceiptId']()).toBe(testMessage.id);
    const ordinary = http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`);
    events.next({
      type: ServerWsMessageType.readReceiptChanged,
      payload: { chatId: testChat.id, privacyChanged: true },
    });
    expect(component['readReceiptId']()).toBeUndefined();
    const privacy = http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`);
    ordinary.flush({ lastReadMessageId: wireMessage.id });
    privacy.flush({});
    await fixture.whenStable();
    expect(component['readReceiptId']()).toBeUndefined();
  });

  it('retains conversation nodes, drafts and composer uploads when a record page covers it', () => {
    const destination = new ActivatedRouteSnapshot();
    destination.data = { preserveConversation: true };
    vi.spyOn(TestBed.inject(Router).routerState.snapshot.root, 'firstChild', 'get').mockReturnValue(destination);
    const node = fixture.nativeElement.querySelector('app-message');
    const page = component['conversation'].page();
    component['draft'].set('unfinished draft');
    const reset = vi.spyOn(component['composer']()!, 'reset');
    component.ionViewDidLeave();
    expect(component['conversation'].page()).toBe(page);
    expect(fixture.nativeElement.querySelector('app-message')).toBe(node);
    expect(component['draft']()).toBe('unfinished draft');
    expect(reset).not.toHaveBeenCalled();
  });

  it('retains DM read checks while covered and applies local privacy saves without a WebSocket echo', async () => {
    TestBed.inject(ChatStore).remember([{ ...testChat, kind: GroupKind.dm }]);
    fixture.detectChanges();
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`).flush({ lastReadMessageId: wireMessage.id });
    await fixture.whenStable();
    component['active'].set(false);
    fixture.detectChanges();
    expect(component['isReadByPeer'](testMessage)).toBe(true);
    TestBed.inject(ChatStore).invalidateReadReceiptPrivacy();
    expect(component['isReadByPeer'](testMessage)).toBe(false);
    http.expectNone(`/_api/chats/${wireChat.id}/read-receipt`);
    component['active'].set(true);
    fixture.detectChanges();
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`).flush({});
    await fixture.whenStable();
    expect(component['isReadByPeer'](testMessage)).toBe(false);
  });

  it('ignores own and unrelated receipt scopes and shares lifecycle requests', async () => {
    TestBed.inject(ChatStore).remember([{ ...testChat, kind: GroupKind.dm }]);
    fixture.detectChanges();
    component['invalidateReadReceipt']();
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`).flush({});
    await fixture.whenStable();
    events.next({
      type: ServerWsMessageType.readReceiptChanged,
      payload: { chatId: testChat.id, readerUid: testUser.uid },
    });
    events.next({
      type: ServerWsMessageType.readReceiptChanged,
      payload: { chatId: testChat.id, readerUid: 2, threadRootId: encodeId('99') },
    });
    http.expectNone(() => true);
    const entering = enterThread();
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt?threadId=100`).flush({});
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`).flush({});
    await entering;
    events.next({
      type: ServerWsMessageType.readReceiptChanged,
      payload: { chatId: testChat.id, readerUid: 2, threadRootId: encodeId('100') },
    });
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt?threadId=100`).flush({ lastReadMessageId: '102' });
    http.expectNone(`/_api/chats/${wireChat.id}/read-receipt`);
    await fixture.whenStable();
    events.next({ type: ServerWsMessageType.readReceiptChanged, payload: { chatId: testChat.id, readerUid: 2 } });
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`).flush({ lastReadMessageId: '100' });
    http.expectNone(`/_api/chats/${wireChat.id}/read-receipt?threadId=100`);
    await fixture.whenStable();
  });

  it('uses separate DM and thread receipts for the root and replies, without reading another thread', async () => {
    const chats = TestBed.inject(ChatStore);
    chats.acceptChats([{ ...testChat, kind: GroupKind.dm }], chats.snapshot());
    fixture.detectChanges();
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`).flush({ lastReadMessageId: wireMessage.id });
    await fixture.whenStable();
    const entering = enterThread();
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt?threadId=100`).flush({ lastReadMessageId: '102' });
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`).flush({ lastReadMessageId: '99' });
    await entering;
    expect(chats.chat(testChat.id).peerLastReadMessageId).toBe(encodeId('99'));
    expect(component['isReadByPeer']({ ...testMessage, id: encodeId('101'), replyRootId: encodeId('100') })).toBe(true);
    expect(component['isReadByPeer']({ ...testMessage, id: encodeId('100') })).toBe(false);
    expect(component['isReadByPeer']({ ...testMessage, id: encodeId('101'), replyRootId: encodeId('99') })).toBe(false);
    chats.acceptThreads(
      [
        {
          chatId: testChat.id,
          chatKind: GroupKind.dm,
          chatName: 'DM',
          threadRootMessage: { ...testMessage, id: encodeId('100'), mentions: [] },
          participants: [],
          replyCount: 1,
          lastReplyAt: testMessage.createdAt,
          subscribedAt: testMessage.createdAt,
          archived: false,
          unreadCount: 0,
        },
      ],
      chats.snapshot(),
      chats.subscriptionSnapshot(),
    );
    events.next({ type: ServerWsMessageType.readReceiptChanged, payload: { chatId: testChat.id } });
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt?threadId=100`).flush({ lastReadMessageId: '102' });
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`).flush({ lastReadMessageId: '100' });
    await fixture.whenStable();
    expect(component['isReadByPeer']({ ...testMessage, id: encodeId('100') })).toBe(true);
    expect(chats.chat(testChat.id).peerLastReadMessageId).toBe(encodeId('100'));
    expect(chats.thread(encodeId('100'))?.peerLastReadMessageId).toBe(encodeId('102'));
  });
});
