import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MessageType, type MessageResponse } from '../../../generated/models';
import { testMessage } from '../../api/testing';
import { MessagePreview } from './message-preview';

describe('MessagePreview', () => {
  let fixture: ComponentFixture<MessagePreview>;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    fixture = TestBed.createComponent(MessagePreview);
  });
  function render(message: Partial<MessageResponse>) {
    fixture.componentRef.setInput('message', { ...testMessage, ...message });
    fixture.detectChanges();
    return fixture.nativeElement.textContent.replace(/\s+/g, ' ').trim();
  }

  it.each([
    ['joined the chat', '测试用户 加入了群'],
    ['left the chat', '测试用户 退出了群'],
    ['added 小花', '测试用户 邀请了 小花 加入群'],
    ['removed 小花', '测试用户 将 小花 移出了群'],
    ['pinned a message', '测试用户 置顶了一条消息'],
    ['unpinned a message', '测试用户 取消了一条消息的置顶'],
    ['pinned a message in this thread', '测试用户 在话题中置顶了一条消息'],
    ['unpinned a message in this thread', '测试用户 取消了话题中一条消息的置顶'],
  ])('renders the system phrase %s with its actor', (message, expected) => {
    expect(render({ messageType: MessageType.system, message })).toBe(expected);
    expect(fixture.nativeElement.classList.contains('action')).toBe(true);
  });

  it('preserves the full target name as text, including spaces and markup', () => {
    expect(render({ messageType: MessageType.system, message: 'added 小花 <b>And Bob</b>' })).toBe(
      '测试用户 邀请了 小花 <b>And Bob</b> 加入群',
    );
    expect(fixture.nativeElement.querySelector('b')).toBeNull();
  });

  it('updates the displayed actor from the message and falls back to the uid when the name is missing', () => {
    const message = { messageType: MessageType.system, message: 'joined the chat' };
    expect(render({ ...message, sender: { uid: 2, name: '小花', gender: 0 } })).toBe('小花 加入了群');
    expect(render({ ...message, sender: { uid: 2, gender: 0 } })).toBe('用户 2 加入了群');
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
});
