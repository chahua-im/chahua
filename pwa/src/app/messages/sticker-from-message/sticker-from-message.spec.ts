import { RpcError, RpcErrorCode, RpcTransportError } from '../../api/rpc-error';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { IonModal } from '@ionic/angular';
import { of, Subject, throwError } from 'rxjs';
import { RpcApi } from '../../../generated/rpc-api';
import {
  MessageType,
  StickerPackVisibility,
  type StickerPackOrderItem,
  type StickerPackSummary,
  type StickerSummary,
} from '../../../generated/models';
import { encodeId } from '../../api/snowflake-id';
import { testMessage, testUser } from '../../api/testing';
import { SessionStore } from '../../session/session-store';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { StickerEditor } from '../../settings/sticker-editor/sticker-editor';
import { StickerPreferences } from '../../settings/sticker-preferences';
import { StickerUpdates } from '../sticker-updates';
import { canCreateSticker } from './eligibility';
import { StickerFromMessage } from './sticker-from-message';

const image = {
  id: encodeId('9007199254740997'),
  kind: 'image/webp',
  size: 120,
  url: '/image.webp',
  fileName: 'image.webp',
};
const source = { ...testMessage, messageType: MessageType.text, message: '', attachments: [image] };
const pack: StickerPackSummary = {
  id: encodeId('9007199254741001'),
  name: 'Tea',
  ownerUid: testUser.uid,
  visibility: StickerPackVisibility.private,
  isSubscribed: false,
  stickerCount: 0,
  createdAt: testMessage.createdAt,
  updatedAt: testMessage.createdAt,
};
const sticker: StickerSummary = {
  id: encodeId('9007199254741003'),
  emoji: '👩🏽‍💻',
  createdAt: testMessage.createdAt,
  isFavorited: false,
  media: { id: image.id, contentType: image.kind, size: image.size, url: image.url },
};

describe('message image eligibility', () => {
  it('allows one image and whitespace, including the exact size limit', () => {
    expect(canCreateSticker({ ...source, message: ' \n ', attachments: [{ ...image, size: 10 * 1024 * 1024 }] })).toBe(
      true,
    );
  });
  it.each([
    { isDeleted: true },
    { message: 'caption' },
    { attachments: [] },
    { attachments: [image, image] },
    { messageType: MessageType.file },
    { messageType: MessageType.sticker },
    { attachments: [{ ...image, kind: 'video/webm' }] },
    { attachments: [{ ...image, size: 10 * 1024 * 1024 + 1 }] },
  ])('rejects an ineligible source %j', (change) => expect(canCreateSticker({ ...source, ...change })).toBe(false));
});

describe('StickerFromMessage', () => {
  const user = signal(testUser);
  const api = {
    listOwnedPacks: vi.fn(() => of({ packs: [pack] })),
    createPack: vi.fn(() => of(pack)),
    createFromMessage: vi.fn(() => of(sticker)),
  };
  const preferences = { packOrder: signal<StickerPackOrderItem[]>([]), upsertPackOrderItem: vi.fn() };

  beforeEach(() => {
    user.set(testUser);
    preferences.packOrder.set([]);
    preferences.upsertPackOrderItem.mockClear();
    api.listOwnedPacks.mockReset().mockReturnValue(of({ packs: [pack] }));
    api.createPack.mockReset().mockReturnValue(of(pack));
    api.createFromMessage.mockReset().mockReturnValue(of(sticker));
    vi.spyOn(IonModal.prototype, 'isOpen', 'set').mockImplementation(() => {});
    vi.spyOn(IonModal.prototype, 'dismiss').mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: RpcApi, useValue: { stickers: api } },
        { provide: StickerPreferences, useValue: preferences },
        { provide: SessionStore, useValue: { user } },
      ],
    });
  });

  async function render(packs = [pack]) {
    const fixture = TestBed.createComponent(StickerFromMessage);
    fixture.componentRef.setInput('message', source);
    fixture.componentRef.setInput('packs', packs);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const editor = fixture.debugElement.query(By.directive(StickerEditor)).componentInstance as StickerEditor;
    return { fixture, component, editor };
  }

  it('renders the image and owned-pack selector inside the editor and keeps the selected ID lossless', async () => {
    const other = { ...pack, id: encodeId('9223372036854775807'), name: 'Other' };
    TestBed.overrideComponent(StickerEditor, { remove: { imports: [ContentScrollbars] } });
    const { fixture, component } = await render([pack, other]);
    fixture.debugElement.query(By.directive(IonModal)).nativeElement.dispatchEvent(new CustomEvent('ionMount'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img.preview').getAttribute('src')).toBe(image.url);
    expect(fixture.nativeElement.querySelectorAll('ion-select-option')).toHaveLength(2);
    expect(
      fixture.nativeElement.querySelector('ion-select').closest('ion-item').querySelector('ion-button'),
    ).not.toBeNull();
    fixture.nativeElement
      .querySelector('ion-select')
      .dispatchEvent(new CustomEvent('ionChange', { detail: { value: other.id } }));
    expect(component['packId']()).toBe(other.id);
    await component['save']({ emoji: '🍵', name: '' });
    expect(api.createFromMessage).toHaveBeenCalledWith({
      packId: other.id,
      chatId: source.chatId,
      messageId: source.id,
      emoji: '🍵',
    });
    expect(api.createPack).not.toHaveBeenCalled();
    expect(api.listOwnedPacks).not.toHaveBeenCalled();
  });

  it('preserves a chosen private pack across order updates and saves to that pack', async () => {
    const publicPack = { ...pack, id: encodeId('12345'), visibility: StickerPackVisibility.public };
    const { fixture, component } = await render([publicPack, pack]);
    component['packId'].set(pack.id);
    preferences.packOrder.set([{ stickerPackId: publicPack.id, lastUsedOn: 123 }]);
    fixture.detectChanges();
    expect(component['orderedPacks']()[0].id).toBe(publicPack.id);
    expect(component['packId']()).toBe(pack.id);
    preferences.packOrder.set([{ stickerPackId: pack.id, lastUsedOn: 456 }]);
    fixture.detectChanges();
    expect(component['orderedPacks']()[0].id).toBe(pack.id);
    expect(component['packId']()).toBe(pack.id);
    await component['save']({ emoji: '🍵', name: '' });
    expect(api.createFromMessage).toHaveBeenCalledExactlyOnceWith({
      packId: pack.id,
      chatId: source.chatId,
      messageId: source.id,
      emoji: '🍵',
    });
    expect(api.listOwnedPacks).not.toHaveBeenCalled();
  });

  it.each([{ packs: [] }, { packs: [pack] }])(
    'creates and selects a new pack while preserving sticker inputs (initial packs: %j)',
    async ({ packs }) => {
      const { fixture, component, editor } = await render(packs);
      const created = { ...pack, id: encodeId('9007199254741005'), name: 'New', isSubscribed: true };
      const values = { emoji: '🍵', name: 'Tea' };
      editor['value'].set(values);
      expect(component['saveDisabled']()).toBe(!packs.length);
      component['createPack']();
      fixture.detectChanges();
      const packEditor = component['packEditor']()!;
      const response = new Subject<StickerPackSummary>();
      api.createPack.mockReturnValueOnce(response);
      const changed = vi.spyOn(TestBed.inject(StickerUpdates).changed, 'next');
      const saving = component['savePack']({ name: ' New ', emoji: '' });
      await component['savePack']({ name: ' New ', emoji: '' });
      fixture.detectChanges();
      expect(api.createPack).toHaveBeenCalledExactlyOnceWith({ name: 'New' });
      expect(packEditor.busy()).toBe(true);
      expect(editor.busy()).toBe(true);
      response.next(created);
      await saving;
      fixture.detectChanges();
      expect(component['createOpen']()).toBe(false);
      expect(component['packId']()).toBe(created.id);
      expect(component['orderedPacks']()).toContainEqual(created);
      expect(component['saveDisabled']()).toBe(false);
      expect(editor['value']()).toEqual(values);
      expect(fixture.debugElement.query(By.directive(StickerEditor)).componentInstance).toBe(editor);
      expect(changed).toHaveBeenCalledExactlyOnceWith({ ...created, stickers: [] });
      expect(preferences.upsertPackOrderItem).toHaveBeenCalledWith(
        expect.objectContaining({ stickerPackId: created.id }),
      );
      await component['save'](values);
      expect(api.createFromMessage).toHaveBeenCalledExactlyOnceWith({
        packId: created.id,
        chatId: source.chatId,
        messageId: source.id,
        ...values,
      });
      expect(api.listOwnedPacks).not.toHaveBeenCalled();
    },
  );

  it('preserves both forms on pack creation failure and keeps the old selection when cancelled', async () => {
    const { fixture, component, editor } = await render();
    editor['value'].set({ emoji: '🍵', name: 'Tea' });
    component['createPack']();
    fixture.detectChanges();
    const packEditor = component['packEditor']()!;
    packEditor['value'].set({ name: 'New', emoji: '' });
    api.createPack.mockReturnValueOnce(throwError(() => new Error('offline')));
    await component['savePack']({ name: 'New', emoji: '' });
    fixture.detectChanges();
    expect(component['createFailed']()).toBe(true);
    expect(component['createOpen']()).toBe(true);
    expect(packEditor.busy()).toBe(false);
    expect(packEditor['value']().name).toBe('New');
    expect(editor['value']()).toEqual({ emoji: '🍵', name: 'Tea' });
    expect(component['packId']()).toBe(pack.id);
    packEditor.closed.emit();
    fixture.detectChanges();
    expect(component['createOpen']()).toBe(false);
    expect(component['saveDisabled']()).toBe(false);
    expect(editor['value']()).toEqual({ emoji: '🍵', name: 'Tea' });
  });

  it.each(['destroy', 'account'])('ignores a late new-pack result after %s changes', async (change) => {
    const { fixture, component } = await render([]);
    const response = new Subject<StickerPackSummary>();
    api.createPack.mockReturnValueOnce(response);
    const changed = vi.spyOn(TestBed.inject(StickerUpdates).changed, 'next');
    const pending = component['savePack']({ name: 'New', emoji: '' });
    if (change === 'destroy') fixture.destroy();
    else user.set({ ...testUser, uid: testUser.uid + 1 });
    response.next(pack);
    await pending;
    expect(changed).not.toHaveBeenCalled();
    expect(preferences.upsertPackOrderItem).not.toHaveBeenCalled();
  });

  it('submits only source IDs and metadata, prevents duplicate clicks and reports success on dismissal', async () => {
    const { fixture, component, editor } = await render();
    const response = new Subject<StickerSummary>();
    api.createFromMessage.mockReturnValueOnce(response);
    const added = vi.fn();
    TestBed.inject(StickerUpdates).added.subscribe(added);
    const saved = vi.fn();
    component.saved.subscribe(saved);
    const values = { emoji: '👩🏽‍💻', name: 'Tea' };
    const pending = component['save'](values);
    await component['save'](values);
    fixture.detectChanges();
    expect(editor.busy()).toBe(true);
    expect(api.createFromMessage).toHaveBeenCalledExactlyOnceWith({
      packId: pack.id,
      chatId: source.chatId,
      messageId: source.id,
      ...values,
    });
    response.next(sticker);
    await pending;
    expect(added).toHaveBeenCalledExactlyOnceWith({ pack, sticker });
    expect(saved).not.toHaveBeenCalled();
    editor.closed.emit();
    expect(saved).toHaveBeenCalledOnce();
  });

  it.each([
    [RpcErrorCode.BadRequest, 'invalid'],
    [RpcErrorCode.Forbidden, 'forbidden'],
    [RpcErrorCode.NotFound, 'missing'],
    [RpcErrorCode.Conflict, 'changed'],
    ['disconnected', 'uncertain'],
    ['timeout', 'uncertain'],
  ])('preserves input and never retries a failed RPC (%s)', async (status, key) => {
    api.createFromMessage.mockReturnValueOnce(
      throwError(() =>
        typeof status === 'number'
          ? new RpcError(status, 'failed')
          : new RpcTransportError(status as 'disconnected' | 'timeout'),
      ),
    );
    const { fixture, component, editor } = await render();
    editor['value'].set({ emoji: '🍵', name: 'Tea' });
    await component['save']({ emoji: '🍵', name: 'Tea' });
    fixture.detectChanges();
    expect(component['errorKey']()).toBe(`stickers.fromMessage.${key}`);
    expect(editor['value']()).toEqual({ emoji: '🍵', name: 'Tea' });
    expect(editor.busy()).toBe(false);
    expect(api.createFromMessage).toHaveBeenCalledOnce();
  });

  it.each(['destroy', 'account'])('ignores a late creation result after %s changes', async (change) => {
    const { fixture, component } = await render();
    const response = new Subject<StickerSummary>();
    api.createFromMessage.mockReturnValueOnce(response);
    const added = vi.fn();
    TestBed.inject(StickerUpdates).added.subscribe(added);
    const pending = component['save']({ emoji: '🍵', name: '' });
    if (change === 'destroy') fixture.destroy();
    else user.set({ ...testUser, uid: testUser.uid + 1 });
    response.next(sticker);
    await pending;
    expect(added).not.toHaveBeenCalled();
  });
});
