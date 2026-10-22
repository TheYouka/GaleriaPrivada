/// <reference types="vite/client" />
import type { GaleriaApi } from '@shared/ipc-contract';

declare global {
  interface Window {
    galeria: GaleriaApi;
  }
}

export {};
