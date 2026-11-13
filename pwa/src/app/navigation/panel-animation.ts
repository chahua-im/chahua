import { createAnimation } from '@ionic/angular';

/** A page covers its parent on entry and reveals it on return. */
export function panelSlide(element: HTMLElement, entering: boolean, backwards: boolean) {
  const edge = entering === backwards ? '-30%' : '100%';
  return createAnimation()
    .addElement(element)
    .duration(240)
    .easing('cubic-bezier(0.32, 0.72, 0, 1)')
    .beforeStyles({ 'pointer-events': 'none', 'z-index': entering === backwards ? '0' : '1' })
    .afterClearStyles(['pointer-events', 'z-index', 'transform'])
    .fromTo(
      'transform',
      entering ? `translateX(${edge})` : 'translateX(0)',
      entering ? 'translateX(0)' : `translateX(${edge})`,
    );
}

export function panelModalSlide(element: HTMLElement, entering: boolean, sheet: boolean) {
  const wrapper = element.shadowRoot!.querySelector<HTMLElement>('.modal-wrapper')!;
  const animation = createAnimation()
    .addElement(wrapper)
    .duration(240)
    .easing('cubic-bezier(0.32, 0.72, 0, 1)')
    .beforeStyles({ opacity: '1' })
    .fromTo(
      'transform',
      entering ? `translate${sheet ? 'Y' : 'X'}(100%)` : 'translate(0)',
      entering ? 'translate(0)' : `translate${sheet ? 'Y' : 'X'}(100%)`,
    );
  const backdrop = element.shadowRoot!.querySelector('ion-backdrop');
  if (backdrop)
    animation.addAnimation(
      createAnimation()
        .addElement(backdrop)
        .fromTo('opacity', entering ? '0' : 'var(--backdrop-opacity)', entering ? 'var(--backdrop-opacity)' : '0'),
    );
  return animation;
}
