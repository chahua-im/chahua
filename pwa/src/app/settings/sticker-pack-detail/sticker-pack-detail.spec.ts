import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AlertController, ModalController } from '@ionic/angular';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import {
  StickerPackVisibility,
  type StickerPackDetailResponse,
  type StickerPackSummary,
  type StickerSummary,
} from '../../../generated/models';
import { provideRpcTesting, RpcTestPeer } from '../../api/rpc-testing';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { testUser } from '../../api/testing';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { SessionStore } from '../../session/session-store';
import { StickerEditor } from '../sticker-editor/sticker-editor';
import { StickerPreferences } from '../sticker-preferences';
import { StickerPackDetail } from './sticker-pack-detail';

const sticker: StickerSummary = {
  id: encodeId('101'),
  createdAt: '2026-09-08T00:00:00Z',
  emoji: '🍵',
  isFavorited: false,
  media: { id: encodeId('102'), contentType: 'image/png', size: 12, url: 'https://example.test/sticker.png' },
};
const pack: StickerPackDetailResponse = {
  id: encodeId('201'),
  name: '我的包',
  createdAt: sticker.createdAt,
  updatedAt: sticker.createdAt,
  ownerUid: 1,
  isSubscribed: true,
  visibility: StickerPackVisibility.public,
  stickerCount: 1,
  stickers: [sticker],
};
const wireSticker = { ...sticker, id: '101', media: { ...sticker.media, id: '102' } };
const wirePack = { ...pack, id: '201', stickers: [wireSticker] };
const wireSummary = (value: StickerPackSummary) => ({
  ...value,
  id: decodeId(value.id),
  previewSticker: value.previewSticker && {
    ...value.previewSticker,
    id: decodeId(value.previewSticker.id),
    media: { ...value.previewSticker.media, id: decodeId(value.previewSticker.media.id) },
  },
});

describe('StickerPackDetail', () => {
  let peer: RpcTestPeer;
  let http: HttpTestingController;
  let preferences = { removePackOrderItem: vi.fn() };
  let alerts = { create: vi.fn() };
  let dismiss = vi.fn();

  beforeEach(() => {
    preferences = { removePackOrderItem: vi.fn() };
    alerts = {
      create: vi.fn(async () => ({
        present: async () => {},
        onDidDismiss: async () => ({ role: 'destructive' }),
      })),
    };
    dismiss = vi.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        provideChahuaBaseUrl('/_api'),
        provideRpcTesting(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ModalController, useValue: { dismiss } },
        { provide: PanelNavigation, useValue: { back: dismiss, close: dismiss, registerLeaveCheck: () => () => {} } },
        { provide: AlertController, useValue: alerts },
        { provide: StickerPreferences, useValue: preferences },
        { provide: SessionStore, useValue: { user: signal({ ...testUser }) } },
      ],
    });
    TestBed.overrideComponent(StickerEditor, { set: { template: '<ion-modal [canDismiss]="canDismiss" />' } });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    try {
      http.verify();
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  function page(packId: SnowflakeID = pack.id) {
    const fixture = TestBed.createComponent(StickerPackDetail);
    fixture.componentRef.setInput('packId', packId);
    fixture.detectChanges();
    return fixture;
  }

  async function loaded() {
    const fixture = page();
    peer.expect('stickers.getPack', { packId: '201' }).flush(wirePack);
    await vi.waitFor(() => expect(fixture.componentInstance['pack']()).toBeDefined());
    return fixture;
  }

  it('loads the pack and offers rename, delete and add for owned packs', async () => {
    const fixture = await loaded();
    expect(fixture.componentInstance['owned']()).toBe(true);
    expect(fixture.nativeElement.querySelector('.cell.add')).not.toBeNull();
  });

  it('covers each sticker cell until its media paints', async () => {
    const fixture = await loaded();
    fixture.detectChanges();
    const cells = Array.from(fixture.nativeElement.querySelectorAll('.cell') as NodeListOf<HTMLElement>);
    const cell = cells.find((item) => item.querySelector('img'))!;
    const media = cell.querySelector('img')!;
    expect(cell.querySelector('.cell-skeleton')).not.toBeNull();
    expect(media.classList.contains('loaded')).toBe(false);
    media.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(media.classList.contains('loaded')).toBe(true);
  });

  it('renames through the pack endpoint and updates the title signal', async () => {
    const fixture = await loaded();
    const component = fixture.componentInstance;
    component['rename']();
    const save = component['saveName']({ name: ' 新名 ', emoji: '' });
    const { stickers: _stickers, ...summary } = pack;
    peer
      .expect('stickers.updatePack', { packId: '201', name: '新名' })
      .flush(wireSummary({ ...summary, name: '新名' }));
    await save;
    expect(component['pack']()?.name).toBe('新名');
    expect(component['pack']()?.stickers).toEqual([sticker]);
    expect(component['renaming']()).toBe(false);
  });

  it('removes a sticker from an owned pack after confirmation', async () => {
    const component = (await loaded()).componentInstance;
    const remove = component['removeSticker'](sticker);
    (await peer.expectAsync('stickers.removeFromPack', { packId: '201', stickerId: '101' })).flush(null);
    await remove;
    expect(component['pack']()?.stickers).toEqual([]);
    expect(component['pack']()?.stickerCount).toBe(0);
  });

  it('deletes the pack, drops it from the order and closes the page', async () => {
    const component = (await loaded()).componentInstance;
    const deletion = component['deletePack']();
    (await peer.expectAsync('stickers.deletePack', { packId: '201' })).flush(null);
    await deletion;
    expect(preferences.removePackOrderItem).toHaveBeenCalledWith(pack.id);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('unsubscribes from a foreign pack and closes the page', async () => {
    const fixture = page();
    peer.expect('stickers.getPack', { packId: '201' }).flush({ ...wirePack, ownerUid: 2 });
    await vi.waitFor(() => expect(fixture.componentInstance['pack']()).toBeDefined());
    const component = fixture.componentInstance;
    expect(component['owned']()).toBe(false);
    const unsubscribe = component['unsubscribe']();
    (await peer.expectAsync('stickers.unsubscribeFromPack', { packId: '201' })).flush(null);
    await unsubscribe;
    expect(preferences.removePackOrderItem).toHaveBeenCalledWith(pack.id);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('uploads a sticker with its emoji and appends it to the pack', async () => {
    const component = (await loaded()).componentInstance;
    const file = new File(['png-bytes'], 'tea.png', { type: 'image/png' });
    await component['upload']({ target: { files: [file], value: '' } } as unknown as Event);
    expect(component['uploadFile']()).toBeDefined();
    const saving = component['saveSticker']({ emoji: '🍵', name: '茶' });
    const request = http.expectOne('/_api/stickers/packs/201/stickers');
    expect(request.request.method).toBe('POST');
    const body = request.request.body as FormData;
    expect(body.get('emoji')).toBe('🍵');
    expect(body.get('name')).toBe('茶');
    request.flush({ ...sticker, id: encodeId('105') });
    await saving;
    expect(component['pack']()?.stickers).toHaveLength(2);
    expect(component['uploadFile']()).toBeUndefined();
  });

  it('rejects unsupported or oversized files with an explanation alert', async () => {
    const component = (await loaded()).componentInstance;
    const blob = new Blob([new ArrayBuffer(10 * 1024 * 1024 + 1)]);
    await component['upload']({
      target: { files: [new File([blob], 'big.bin', { type: 'application/octet-stream' })], value: '' },
    } as unknown as Event);
    http.expectNone('/_api/stickers/packs/201/stickers');
    expect(alerts.create).toHaveBeenLastCalledWith({
      header: '无法添加贴纸',
      message: '请选择 10 MB 以内的图片或 WebM 视频。',
      buttons: ['知道了'],
    });
  });

  it('survives a failed load through the retry path', async () => {
    const fixture = page();
    peer.expect('stickers.getPack', { packId: '201' }).error(1503);
    await vi.waitFor(() => expect(fixture.componentInstance['error']()).toBe(true));
    const retry = fixture.componentInstance['retry']();
    peer.expect('stickers.getPack', { packId: '201' }).flush(wirePack);
    await retry;
    expect(fixture.componentInstance['pack']()).toBeDefined();
  });

  it('retains the rename form on failure and allows retry', async () => {
    const component = (await loaded()).componentInstance;
    component['rename']();
    const failed = component['saveName']({ name: '新名', emoji: '' });
    peer.expect('stickers.updatePack', { packId: '201', name: '新名' }).error(1503);
    await failed;
    expect(component['renaming']()).toBe(true);
    expect(component['editorError']()).toBeTruthy();
    expect(component['pack']()?.name).toBe(pack.name);
    const retry = component['saveName']({ name: '新名', emoji: '' });
    const { stickers: _stickers, ...summary } = pack;
    peer
      .expect('stickers.updatePack', { packId: '201', name: '新名' })
      .flush(wireSummary({ ...summary, name: '新名' }));
    await retry;
    expect(component['renaming']()).toBe(false);
    expect(component['pack']()?.name).toBe('新名');
  });

  it('keeps the editor mounted until its successful dismissal finishes', async () => {
    const fixture = await loaded();
    const component = fixture.componentInstance;
    component['rename']();
    fixture.detectChanges();
    let finish!: (dismissed: boolean) => void;
    const closing = vi.spyOn(component['editor']()!, 'dismiss').mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const saving = component['saveName']({ name: '新名', emoji: '' });
    const { stickers: _stickers, ...summary } = pack;
    peer
      .expect('stickers.updatePack', { packId: '201', name: '新名' })
      .flush(wireSummary({ ...summary, name: '新名' }));
    await vi.waitFor(() => expect(closing).toHaveBeenCalledOnce());
    expect(component['renaming']()).toBe(true);
    expect(component['busy']()).toBe(true);
    finish(true);
    await saving;
    expect(component['renaming']()).toBe(false);
    expect(component['busy']()).toBe(false);
  });

  it('retains the selected upload after failure so it can be retried', async () => {
    const component = (await loaded()).componentInstance;
    const file = new File(['png-bytes'], 'tea.png', { type: 'image/png' });
    await component['upload']({ target: { files: [file], value: '' } } as unknown as Event);
    const selected = component['uploadFile']();
    const failed = component['saveSticker']({ emoji: '🍵', name: '茶' });
    http.expectOne('/_api/stickers/packs/201/stickers').error(new ProgressEvent('error'));
    await failed;
    expect(component['uploadFile']()).toBe(selected);
    expect(component['editorError']()).toBeTruthy();
    expect(component['pack']()?.stickers).toHaveLength(1);
    const retry = component['saveSticker']({ emoji: '🍵', name: '茶' });
    http.expectOne('/_api/stickers/packs/201/stickers').flush({ ...sticker, id: encodeId('105') });
    await retry;
    expect(component['uploadFile']()).toBeUndefined();
    expect(component['pack']()?.stickers).toHaveLength(2);
  });
});
