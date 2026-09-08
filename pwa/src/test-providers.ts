import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ModalController } from '@ionic/angular';
export default [
  provideRouter([]),
  provideHttpClient(),
  provideHttpClientTesting(),
  {
    provide: ModalController,
    useValue: {
      create: () => Promise.reject(new Error('Provide a dialog mock in this test')),
      dismiss: () => Promise.resolve(true),
      getTop: () => Promise.resolve(undefined),
    },
  },
];
