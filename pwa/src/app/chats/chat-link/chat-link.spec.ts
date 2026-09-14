import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router, UrlSegment } from '@angular/router';
import { ModalController } from '@ionic/angular';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { Settings } from '../../settings/settings/settings';
import { ChatLink } from './chat-link';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('ChatLink route-owned modals', () => {
  let snapshot: {
    url: UrlSegment[];
    paramMap: ReturnType<typeof convertToParamMap>;
    queryParamMap: ReturnType<typeof convertToParamMap>;
    data: Record<string, unknown>;
  };
  let dismissed: ReturnType<typeof deferred<{ role?: string }>>;
  let modal: {
    present: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
    onDidDismiss: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  let create: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    snapshot = {
      url: [new UrlSegment('settings', {})],
      paramMap: convertToParamMap({}),
      queryParamMap: convertToParamMap({}),
      data: { component: Settings },
    };
    dismissed = deferred();
    modal = {
      present: vi.fn().mockResolvedValue(undefined),
      dismiss: vi.fn((_data, role) => {
        dismissed.resolve({ role });
        return Promise.resolve(true);
      }),
      onDidDismiss: vi.fn(() => dismissed.promise),
      remove: vi.fn(),
    };
    create = vi.fn().mockResolvedValue(modal);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'chats', children: [] },
          { path: 'settings', children: [] },
        ]),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: ActivatedRoute, useValue: { snapshot } },
        { provide: ModalController, useValue: { create } },
      ],
    });
    TestBed.overrideComponent(ChatLink, { set: { template: '' } });
    await TestBed.inject(Router).navigateByUrl('/settings');
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('dismisses only its own modal on navigation without triggering another Back', async () => {
    vi.spyOn(TestBed.inject(Router), 'currentNavigation').mockReturnValue({ previousNavigation: {} } as never);
    const page = TestBed.createComponent(ChatLink).componentInstance;
    const back = vi.spyOn(TestBed.inject(Location), 'back');
    const open = page['open']();
    await vi.waitFor(() => expect(modal.present).toHaveBeenCalledOnce());
    page.ionViewWillLeave();
    await open;
    expect(modal.dismiss).toHaveBeenCalledWith(undefined, 'navigate');
    expect(back).not.toHaveBeenCalled();
  });

  it('uses browser history for Done even when Ionic has discarded its forward stack', async () => {
    vi.spyOn(TestBed.inject(Router), 'currentNavigation').mockReturnValue({ previousNavigation: {} } as never);
    const page = TestBed.createComponent(ChatLink).componentInstance;
    const back = vi.spyOn(TestBed.inject(Location), 'back');
    const open = page['open']();
    await vi.waitFor(() => expect(modal.present).toHaveBeenCalledOnce());
    dismissed.resolve({});
    await open;
    expect(back).toHaveBeenCalledOnce();
  });

  it('returns a directly opened modal to chats without leaving the app', async () => {
    const page = TestBed.createComponent(ChatLink).componentInstance;
    const back = vi.spyOn(TestBed.inject(Location), 'back');
    const open = page['open']();
    await vi.waitFor(() => expect(modal.present).toHaveBeenCalledOnce());
    dismissed.resolve({});
    await open;
    expect(TestBed.inject(Router).url).toBe('/chats');
    expect(back).not.toHaveBeenCalled();
  });

  it('does not open a stale profile after the user has already returned', async () => {
    snapshot.paramMap = convertToParamMap({ uid: '2' });
    const page = TestBed.createComponent(ChatLink).componentInstance;
    const open = page['open']();
    const request = TestBed.inject(HttpTestingController).expectOne('/_api/users/search?q=2&limit=20');
    page.ionViewWillLeave();
    request.flush({ members: [{ uid: 2, username: 'Alice', gender: 0 }] });
    await open;
    expect(create).not.toHaveBeenCalled();
  });

  it('closes a presentation that finishes after navigation', async () => {
    const presenting = deferred<void>();
    modal.present.mockReturnValue(presenting.promise);
    const page = TestBed.createComponent(ChatLink).componentInstance;
    const open = page['open']();
    await vi.waitFor(() => expect(modal.present).toHaveBeenCalledOnce());
    page.ionViewWillLeave();
    presenting.resolve();
    await open;
    expect(modal.dismiss).toHaveBeenLastCalledWith(undefined, 'navigate');
  });
  it('ignores an Ionic entry callback for a route the browser has already left', async () => {
    const page = TestBed.createComponent(ChatLink).componentInstance;
    await TestBed.inject(Router).navigateByUrl('/chats');
    page.ionViewDidEnter();
    expect(create).not.toHaveBeenCalled();
  });
});
