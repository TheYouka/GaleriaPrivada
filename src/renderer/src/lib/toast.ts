// Cola de avisos breves; los pinta components/Toast.tsx (Radix Toast, que ya los anuncia).
import { create } from 'zustand';

export interface ToastItem {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

interface ToastState {
  items: ToastItem[];
  next: number;
}

export const useToastStore = create<ToastState>(() => ({ items: [], next: 1 }));

export function toast(message: string, tone: ToastItem['tone'] = 'info'): void {
  useToastStore.setState((s) => ({
    items: [...s.items.slice(-2), { id: s.next, message, tone }],
    next: s.next + 1,
  }));
}

export function dismissToast(id: number): void {
  useToastStore.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}
