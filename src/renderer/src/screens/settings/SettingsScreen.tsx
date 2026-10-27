// Ajustes (docs/DESIGN.md §14.9), secciones en Tabs verticales. F1: Apariencia y Seguridad; F2:
// Almacenamiento; F4: Música y Presentación; Acerca de llega con su fase. La pestaña activa
// vive en nav-store, así que se conserva al cambiar de tema.
import { Tabs } from 'radix-ui';
import { ScreenHeading } from '../../components/ScreenHeading';
import { useNavStore, type SettingsTab } from '../../stores/nav-store';
import { AppearanceTab } from './AppearanceTab';
import { MusicLibrary } from './MusicLibrary';
import { PresentationTab } from './PresentationTab';
import { SecurityTab } from './SecurityTab';
import { StorageTab } from './StorageTab';

const TABS: { value: SettingsTab; label: string }[] = [
  { value: 'appearance', label: 'Apariencia' },
  { value: 'security', label: 'Seguridad' },
  { value: 'storage', label: 'Almacenamiento' },
  { value: 'music', label: 'Música' },
  { value: 'presentation', label: 'Presentación' },
];

export function SettingsScreen() {
  const tab = useNavStore((s) => s.settingsTab);
  return (
    <div className="flex flex-col gap-6 p-8">
      <ScreenHeading className="text-3xl text-text">Ajustes</ScreenHeading>
      <Tabs.Root
        orientation="vertical"
        value={tab}
        onValueChange={(v) => {
          const next = TABS.find((t) => t.value === v);
          if (next) useNavStore.getState().setSettingsTab(next.value);
        }}
        className="flex gap-8"
      >
        <Tabs.List aria-label="Secciones de ajustes" className="flex w-44 shrink-0 flex-col gap-1">
          {TABS.map((t) => (
            <Tabs.Trigger
              key={t.value}
              value={t.value}
              className="flex h-10 items-center rounded-md px-3 text-left text-sm text-text hover:bg-surface-hover data-[state=active]:bg-surface-hover data-[state=active]:font-semibold"
            >
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="appearance" className="min-w-0 flex-1">
          <AppearanceTab />
        </Tabs.Content>
        <Tabs.Content value="security" className="min-w-0 flex-1">
          <SecurityTab />
        </Tabs.Content>
        <Tabs.Content value="storage" className="min-w-0 flex-1">
          <StorageTab />
        </Tabs.Content>
        <Tabs.Content value="music" className="min-w-0 flex-1">
          <MusicLibrary />
        </Tabs.Content>
        <Tabs.Content value="presentation" className="min-w-0 flex-1">
          <PresentationTab />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
