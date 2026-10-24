import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { encodeId } from '../../api/snowflake-id';
import { provideRouter, Router } from '@angular/router';
import { MessageType, type MessageResponse } from '../../../generated/models';
import { testMessage } from '../../api/testing';
import { MessagePreview } from './message-preview';

describe('MessagePreview', () => {
  let fixture: ComponentFixture<MessagePreview>;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'profile/:uid', children: [] },
          { path: 'm/:encoded', children: [] },
        ]),
      ],
    });
    fixture = TestBed.createComponent(MessagePreview);
  });
  function render(message: Partial<MessageResponse>) {
    fixture.componentRef.setInput('message', { ...testMessage, ...message });
    fixture.detectChanges();
    return fixture.nativeElement.textContent.replace(/\s+/g, ' ').trim();
  }

  it.each([
    ['joined the chat', '测试用户 加入了群聊'],
    ["accepted O'Brien's friend request", "测试用户 接受了 O'Brien 的好友申请"],
    ['left the chat', '测试用户 退出了群聊'],
    ['added 小花', '测试用户 邀请 小花 加入了群聊'],
    ['removed 小花', '测试用户 将 小花 移出了群聊'],
    ['pinned a message', '测试用户 置顶了消息'],
    ['unpinned a message', '测试用户 取消置顶了消息'],
    ['pinned a message in this thread', '测试用户 在本话题中置顶了消息'],
    ['unpinned a message in this thread', '测试用户 在话题中取消置顶了消息'],
  ])('renders the system phrase %s with its actor', (message, expected) => {
    expect(render({ messageType: MessageType.system, message })).toBe(expected);
    expect(fixture.nativeElement.classList.contains('action')).toBe(true);
  });

  it('preserves the full target name as text, including spaces and markup', () => {
    expect(render({ messageType: MessageType.system, message: 'added 小花 <b>And Bob</b>' })).toBe(
      '测试用户 邀请 小花 <b>And Bob</b> 加入了群聊',
    );
    expect(fixture.nativeElement.querySelector('b')).toBeNull();
  });

  it('updates the displayed actor from the message and falls back to the uid when the name is missing', () => {
    const message = { messageType: MessageType.system, message: 'joined the chat' };
    expect(render({ ...message, sender: { uid: 2, name: '小花', gender: 0 } })).toBe('小花 加入了群聊');
    expect(render({ ...message, sender: { uid: 2, gender: 0 } })).toBe('用户 2 加入了群聊');
  });

  it('opens the actor profile only when the system message is interactive', async () => {
    const message = {
      messageType: MessageType.system,
      message: 'joined the chat',
      sender: { uid: 2, name: '小花', gender: 0 },
    };
    render(message);
    expect(fixture.nativeElement.querySelector('a')).toBeNull();
    fixture.componentRef.setInput('interactive', true);
    render(message);
    const link: HTMLAnchorElement = fixture.nativeElement.querySelector('a');
    expect(link.textContent).toBe('小花');
    const parentClick = vi.fn();
    fixture.nativeElement.addEventListener('click', parentClick);
    link.click();
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/profile/2');
    expect(parentClick).not.toHaveBeenCalled();
    fixture.componentRef.setInput('interactive', false);
    render(message);
    expect(fixture.nativeElement.querySelector('a')).toBeNull();
  });

  it.each([
    ['added 小花', '小花'],
    ['removed 小花', '小花'],
    ["accepted O'Brien's friend request", "O'Brien"],
  ])('links the target of %s using its UID', async (message, name) => {
    const source = { messageType: MessageType.system, message, systemLinks: { uid: 42 } };
    render(source);
    expect(fixture.nativeElement.querySelector('a')).toBeNull();
    fixture.componentRef.setInput('interactive', true);
    render(source);
    const links: NodeListOf<HTMLAnchorElement> = fixture.nativeElement.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[1].textContent).toBe(name);
    const parentClick = vi.fn();
    fixture.nativeElement.addEventListener('click', parentClick);
    links[1].click();
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/profile/42');
    expect(parentClick).not.toHaveBeenCalled();
    fixture.componentRef.setInput('interactive', false);
    render(source);
    expect(fixture.nativeElement.querySelector('a')).toBeNull();
  });

  it.each([
    'pinned a message',
    'unpinned a message',
    'pinned a message in this thread',
    'unpinned a message in this thread',
  ])('links %s to the exact target, separately from its thread root', async (message) => {
    const source = {
      messageType: MessageType.system,
      message,
      systemLinks: { messageId: testMessage.id },
      replyRootId: encodeId('9007199254740995'),
    };
    fixture.componentRef.setInput('interactive', true);
    render(source);
    const links: NodeListOf<HTMLAnchorElement> = fixture.nativeElement.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[1].textContent).toBe('消息');
    expect(links[1].getAttribute('href')).toBe('/m/ACAAAAAAAAEAIAAAAAAACw');
    const parentClick = vi.fn();
    fixture.nativeElement.addEventListener('click', parentClick);
    links[1].click();
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/m/ACAAAAAAAAEAIAAAAAAACw');
    expect(parentClick).not.toHaveBeenCalled();
    fixture.componentRef.setInput('interactive', false);
    render(source);
    expect(fixture.nativeElement.querySelector('a')).toBeNull();
  });

  it.each(['added 小花', "accepted 小花's friend request", 'pinned a message in this thread'])(
    'does not guess a destination for legacy %s',
    (message) => {
      fixture.componentRef.setInput('interactive', true);
      render({ messageType: MessageType.system, message, replyRootId: testMessage.id });
      expect(fixture.nativeElement.querySelectorAll('a')).toHaveLength(1);
    },
  );

  it('preserves translation word order and links when changing languages', async () => {
    fixture.componentRef.setInput('interactive', true);
    const transloco = TestBed.inject(TranslocoService);
    const target = {
      messageType: MessageType.system,
      message: "accepted 小花's friend request",
      systemLinks: { uid: 42 },
    };
    for (const [locale, accepted, pinned] of [
      ['zh-CN', '测试用户 接受了 小花 的好友申请', '测试用户 在本话题中置顶了消息'],
      ['en', "测试用户 accepted 小花's friend request", '测试用户 pinned a message in this thread'],
      ['zh-TW', '测试用户 接受了 小花 的好友申請', '测试用户 在本話題中置頂了訊息'],
    ]) {
      await firstValueFrom(transloco.load(locale));
      transloco.setActiveLang(locale);
      expect(render(target)).toBe(accepted);
      expect(fixture.nativeElement.querySelectorAll('a')[1].getAttribute('href')).toBe('/profile/42');
      expect(
        render({
          messageType: MessageType.system,
          message: 'pinned a message in this thread',
          systemLinks: { messageId: testMessage.id },
        }),
      ).toBe(pinned);
      expect(fixture.nativeElement.querySelectorAll('a')[1].getAttribute('href')).toBe('/m/ACAAAAAAAAEAIAAAAAAACw');
    }
  });

  it('renders target names as text even when they contain markup or interpolation markers', () => {
    fixture.componentRef.setInput('interactive', true);
    const name = '<img src=x> {{ target }} \uFFFC';
    expect(
      render({
        messageType: MessageType.system,
        message: `accepted ${name}'s friend request`,
        systemLinks: { uid: 42 },
      }),
    ).toBe(`测试用户 接受了 ${name} 的好友申请`);
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('a')).toHaveLength(2);
  });

  it('keeps unknown system text instead of silently discarding it', () => {
    expect(render({ messageType: MessageType.system, message: 'changed the group theme' })).toBe(
      '测试用户 changed the group theme',
    );
  });

  it('does not translate or highlight a user message that happens to contain a protocol phrase', () => {
    expect(render({ messageType: MessageType.text, message: 'joined the chat' })).toBe('joined the chat');
    expect(fixture.nativeElement.classList.contains('action')).toBe(false);
  });

  it('describes an invitation instead of displaying its protocol code', () => {
    expect(render({ messageType: MessageType.invite, message: 'abcdefghij' })).toBe('[邀请]');
    expect(fixture.nativeElement.classList.contains('action')).toBe(true);
  });

  it('marks generated media labels and deletion notices as actions, but leaves user captions as text', () => {
    expect(render({ messageType: MessageType.audio, message: undefined })).toBe('[语音]');
    expect(fixture.nativeElement.classList.contains('action')).toBe(true);
    expect(render({ messageType: MessageType.file, message: '我的文件说明' })).toBe('我的文件说明');
    expect(fixture.nativeElement.classList.contains('action')).toBe(false);
    expect(render({ isDeleted: true })).toBe('消息已删除');
    expect(fixture.nativeElement.classList.contains('action')).toBe(true);
  });
  it('keeps attachment types alongside a caption and resolves mentions in the caption', () => {
    const attachment = { id: testMessage.id, url: '/local-media', size: 1, fileName: '附件' };
    const text = render({
      message: '给 @[uid:2] 看看',
      mentions: [{ uid: 2, username: '小花', gender: 0 }],
      attachments: [
        { ...attachment, kind: 'image/jpeg' },
        { ...attachment, kind: 'image/png' },
        { ...attachment, kind: 'video/mp4' },
      ],
    });
    expect(text).toContain('[图片]');
    expect(text).toContain('[视频]');
    expect(text.match(/\[图片\]/g)).toHaveLength(1);
    expect(text).toContain('给 @小花 看看');
    expect(fixture.nativeElement.querySelector('a')).toBeNull();
  });
});
