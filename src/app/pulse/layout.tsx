import type { Metadata, Viewport } from 'next';
import './pulse.css';
import { PulseProvider } from './_ui/PulseProvider';
import { Nav } from './_ui/bits';

export const metadata: Metadata = {
  title: 'PULSE Studio',
  description: 'Одна идея превращается в согласованный пакет публикаций для всех площадок',
};

// приложение всегда в своей палитре: тему Telegram не наследуем
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0B0B0C',
};

export default function PulseLayout({ children }: { children: React.ReactNode }) {
  return (
    <PulseProvider>
      <div className="pulse">
        {children}
        <Nav />
      </div>
    </PulseProvider>
  );
}
