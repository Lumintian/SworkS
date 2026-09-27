import { useState, type ReactNode } from 'react';
import { hasOpenOverlay, useKeydown } from '../lib/hotkeys';
import { CommandPalette } from './CommandPalette';
import { NavPane } from './NavPane';

export function Layout({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  useKeydown((e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      if (!paletteOpen && hasOpenOverlay()) return false;
      setPaletteOpen((o) => !o);
      return true;
    }
    return false;
  });

  return (
    <div className="min-h-screen md:grid md:grid-cols-[16.5rem_1fr]">
      <NavPane onOpenPalette={() => setPaletteOpen(true)} />
      <main className="min-w-0 px-4 pb-16 pt-4 md:px-8 md:pt-6">
        <div className="mx-auto max-w-[1180px]">{children}</div>
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
