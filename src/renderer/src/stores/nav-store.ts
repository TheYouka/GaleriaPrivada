// Navegación (docs/DESIGN.md §14.1 y §14.5): pantalla de perfiles con la bóveda bloqueada, entrada
// del NavModel con la bóveda abierta y pestaña de Ajustes. Vive fuera de los shells, así que cambiar
// de tema conserva la pantalla actual (§15.8, punto 3).
import { create } from 'zustand';
import type { Id } from '@shared/types';
import type { NavKey } from '../themes/shells/nav-model';

export type ProfilesView =
  | { name: 'picker'; focusProfileId?: Id }
  | { name: 'manage'; focusProfileId?: Id }
  | { name: 'create' }
  | { name: 'edit'; profileId: Id };

export type SettingsTab = 'appearance' | 'security';

interface NavState {
  profilesView: ProfilesView;
  active: NavKey;
  settingsTab: SettingsTab;
  /** Aumenta en cada cambio de pantalla: el foco pasa a su <h1> (§14.1). */
  seq: number;
  /** Último `seq` cuyo foco ya se movió (un remontaje por cambio de tema no lo repite). */
  focusedSeq: number;
  showProfiles(view: ProfilesView): void;
  navigate(key: NavKey): void;
  setSettingsTab(tab: SettingsTab): void;
  markFocused(seq: number): void;
}

export const useNavStore = create<NavState>((set) => ({
  profilesView: { name: 'picker' },
  active: 'gallery-all',
  settingsTab: 'appearance',
  seq: 0,
  focusedSeq: -1,
  showProfiles: (view) => set((s) => ({ profilesView: view, seq: s.seq + 1 })),
  navigate: (key) => set((s) => ({ active: key, seq: s.seq + 1 })),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  markFocused: (seq) => set({ focusedSeq: seq }),
}));
